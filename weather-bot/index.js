process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED]", err);
});

const config = require("./config");
const { fetchEnsembleForecast, extractDailyMaxFromEnsemble } = require("./services/ensemble");
const { fetchECMWF } = require("./services/ecmwf");
const { fetchHRRR } = require("./services/hrrr");
const { fetchMETAR } = require("./services/metar");
const { fetchOpenMarkets, discoverWeatherSeries, parseWeatherMarket } = require("./services/kalshi");
const { getActualHigh, checkKalshiResolution } = require("./services/nws");
const { computeProbability, computeEnsembleProb, calcEV, findEdge } = require("./engine/edge");
const { sizePosition } = require("./engine/kelly");
const { runCalibration, getCalibratedSigma, generateReport } = require("./engine/calibration");
const { loadState, saveState, appendTrade, appendCalibration } = require("./storage/logger");
const { loadMarket, saveMarket, newMarket } = require("./storage/markets");
const { sleep } = require("./utils/helpers");

// ── Determine forecast horizon (D+0, D+1, D+2, etc.) ──
function getHorizon(forecastDate) {
  const now = new Date();
  const target = new Date(forecastDate + "T23:59:59Z");
  const hoursLeft = (target - now) / (1000 * 60 * 60);
  if (hoursLeft < 24) return { label: "D+0", hoursLeft };
  if (hoursLeft < 48) return { label: "D+1", hoursLeft };
  return { label: `D+${Math.floor(hoursLeft / 24)}`, hoursLeft };
}

// ── Pick best forecast source for a city/date ──
function pickBestForecast(cityConfig, horizon, forecasts) {
  const { hrrr, ecmwf, metar } = forecasts;

  // US cities on D+0/D+1: prefer HRRR
  if (cityConfig.region === "us" && (horizon === "D+0" || horizon === "D+1") && hrrr != null) {
    return { temp: hrrr, source: "hrrr" };
  }
  // All others: ECMWF
  if (ecmwf != null) return { temp: ecmwf, source: "ecmwf" };
  // Fallback to HRRR if ECMWF unavailable
  if (hrrr != null) return { temp: hrrr, source: "hrrr" };
  return { temp: null, source: null };
}

// ── Compute hours until market closes ──
function hoursUntilClose(closeTime) {
  if (!closeTime) return null;
  const close = new Date(closeTime);
  if (isNaN(close)) return null;
  return (close - new Date()) / (1000 * 60 * 60);
}

// ── Full scan: fetch forecasts, evaluate markets, enter trades ──
async function scan() {
  const state = loadState();
  const ts = new Date().toISOString();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  SCAN | ${ts} | Bankroll: $${state.bankroll.toFixed(2)} | W/L: ${state.wins}/${state.losses} | Pending: ${state.pending.length}`);
  console.log(`${"=".repeat(70)}`);

  // Discover active weather series from Kalshi
  const seriesTickers = await discoverWeatherSeries();
  console.log(`  Discovered ${seriesTickers.length} weather series: ${seriesTickers.join(", ")}`);

  for (const seriesTicker of seriesTickers) {
    const cityConfig = config.cities[seriesTicker];
    if (!cityConfig) {
      console.log(`\n  [SKIP] ${seriesTicker} — not in seed list (add to config.js)`);
      continue;
    }

    console.log(`\n  ${cityConfig.name} (${seriesTicker})`);

    try {
      // ── Fetch all forecast sources in parallel ──
      const [ensembleData, ecmwfData, hrrrData, metarTemp] = await Promise.all([
        fetchEnsembleForecast(cityConfig.lat, cityConfig.lon, 3).catch(e => { console.log(`     [!] Ensemble: ${e.message}`); return null; }),
        fetchECMWF(cityConfig.lat, cityConfig.lon, cityConfig.timezone).catch(e => { console.log(`     [!] ECMWF: ${e.message}`); return null; }),
        cityConfig.region === "us"
          ? fetchHRRR(cityConfig.lat, cityConfig.lon, cityConfig.timezone).catch(e => { console.log(`     [!] HRRR: ${e.message}`); return null; })
          : Promise.resolve(null),
        cityConfig.station
          ? fetchMETAR(cityConfig.station).catch(() => null)
          : Promise.resolve(null),
      ]);

      const dailyMax = ensembleData ? extractDailyMaxFromEnsemble(ensembleData) : null;
      if (!dailyMax?.length) { console.log("     [!] No ensemble data"); continue; }

      // Fetch open markets from Kalshi
      const markets = await fetchOpenMarkets(seriesTicker);
      if (!markets.length) { console.log("     [!] No open markets"); continue; }
      console.log(`     Markets: ${markets.length} brackets | Sources: ensemble${ecmwfData ? "+ECMWF" : ""}${hrrrData ? "+HRRR" : ""}${metarTemp != null ? "+METAR(" + metarTemp + "F)" : ""}`);

      for (const market of markets) {
        const parsed = parseWeatherMarket(market);
        if (parsed.bracketLow == null || isNaN(parsed.bracketLow) || !parsed.marketPrice) {
          continue; // silently skip unparseable
        }

        // ── Filter: max price ──
        if (parsed.marketPrice > config.maxPrice) continue;

        // ── Filter: volume ──
        if (parsed.volume < config.minVolume) continue;

        // ── Filter: spread/slippage ──
        if (parsed.spread != null && parsed.spread > config.maxSlippage) continue;

        // ── Filter: time horizon ──
        const hrsLeft = hoursUntilClose(parsed.closeTime);
        if (hrsLeft != null && (hrsLeft < config.minHours || hrsLeft > config.maxHours)) continue;

        // ── Match forecast date to market ──
        // Try to extract date from ticker (e.g., KXHIGHNY-26MAR25-B58 → 2026-03-26)
        const forecastDate = extractDateFromTicker(parsed.ticker) || (dailyMax.length > 1 ? dailyMax[1].date : dailyMax[0].date);
        const dayData = dailyMax.find(d => d.date === forecastDate) || dailyMax[dailyMax.length > 1 ? 1 : 0];

        if (!dayData || dayData.mean == null) continue;

        const horizon = getHorizon(forecastDate);

        // ── Get point forecasts ──
        const forecasts = {
          hrrr: hrrrData?.[forecastDate] ?? null,
          ecmwf: ecmwfData?.[forecastDate] ?? null,
          metar: metarTemp,
        };
        const best = pickBestForecast(cityConfig, horizon.label, forecasts);

        // ── Determine sigma: calibrated if available, else ensemble std ──
        const calibratedSigma = best.source ? getCalibratedSigma(seriesTicker, best.source) : null;
        const sigma = calibratedSigma ?? dayData.std ?? 3.0; // default 3°F if nothing else

        // Use best point forecast as mean, or ensemble mean as fallback
        const forecastMean = best.temp ?? dayData.mean;

        // ── Primary signal: raw ensemble member counting (honest, no distribution assumption) ──
        const rawProb = computeEnsembleProb(dayData.maxTemps, parsed.bracketLow, parsed.bracketHigh, parsed.type);
        const memberCount = Math.round(rawProb * dayData.memberCount);

        // Secondary: CDF-based probability (for confirmation only)
        const cdfProb = computeProbability(forecastMean, sigma, parsed.bracketLow, parsed.bracketHigh, parsed.type);

        // Use ensemble prob as primary, CDF as confirmation
        const prob = rawProb;
        const rawEdge = findEdge(rawProb, parsed.marketPrice);

        // Use ask price for entry (honest simulation)
        const entryPrice = parsed.askPrice || parsed.marketPrice;
        const ev = calcEV(prob, entryPrice);

        // ── Log calibration data ──
        appendCalibration({
          timestamp: ts,
          city: cityConfig.name,
          citySlug: seriesTicker,
          ticker: parsed.ticker,
          bracket: parsed.subtitle,
          type: parsed.type,
          ensembleProb: +rawProb.toFixed(3),
          cdfProb: +prob.toFixed(3),
          marketPrice: +parsed.marketPrice.toFixed(3),
          edge: +rawEdge.toFixed(3),
          ev: +ev.toFixed(4),
          forecastMean: +forecastMean.toFixed(1),
          sigma: +sigma.toFixed(2),
          source: best.source,
          memberCount: dayData.memberCount,
          forecastDate,
        });

        // ── Save forecast snapshot to per-market file ──
        const slug = seriesTicker.toLowerCase();
        let mkt = loadMarket(slug, forecastDate) || newMarket(slug, cityConfig.name, forecastDate);
        mkt.forecast_snapshots.push({
          ts,
          horizon: horizon.label,
          hours_left: +(horizon.hoursLeft.toFixed(1)),
          ecmwf: forecasts.ecmwf,
          hrrr: forecasts.hrrr,
          metar: forecasts.metar,
          ensemble_mean: dayData.mean,
          ensemble_std: dayData.std,
          best: best.temp,
          best_source: best.source,
        });
        mkt.market_snapshots.push({
          ts,
          ticker: parsed.ticker,
          price: parsed.marketPrice,
          ask: parsed.askPrice,
          bid: parsed.bidPrice,
          spread: parsed.spread,
          volume: parsed.volume,
        });
        saveMarket(mkt);

        // ── ENTRY FILTERS ──
        // Determine trade side: YES if our prob > market, NO if market overprices
        const edge = rawProb - parsed.marketPrice;
        const side = edge > 0 ? "YES" : "NO";
        const tradeProb = side === "YES" ? prob : 1 - prob;
        const tradePrice = side === "YES" ? entryPrice : (1 - (parsed.bidPrice || parsed.marketPrice));
        const tradeEV = calcEV(tradeProb, tradePrice);

        // Minimum probability: reject lottery tickets
        if (tradeProb < 0.15) continue;

        // Minimum ensemble member agreement (need at least 5/31)
        const agreeing = side === "YES" ? memberCount : (dayData.memberCount - memberCount);
        if (agreeing < 5) continue;

        // Require BOTH ensemble and CDF to agree on direction
        const cdfEdge = side === "YES" ? (cdfProb - parsed.marketPrice) : (parsed.marketPrice - cdfProb);
        if (cdfEdge <= 0) continue; // CDF disagrees — don't trade

        // EV must clear threshold
        if (tradeEV < config.minEV) continue;

        // Edge must be meaningful
        if (Math.abs(edge) < config.minEV) continue;

        // Max entry price
        if (tradePrice > config.maxPrice) continue;

        // ── Position sizing via Kelly ──
        const posSize = sizePosition(tradeProb, tradePrice, state.bankroll);
        if (posSize < 0.50) continue; // too small

        const contracts = Math.floor(posSize / tradePrice);
        if (contracts < 1) continue;
        const cost = +(contracts * tradePrice).toFixed(2);

        // Can't afford it
        if (cost > state.bankroll) continue;

        // ── Duplicate check (includes side) ──
        const dupeKey = `${cityConfig.name}|${parsed.ticker}|${forecastDate}|${side}`;
        const isDupe = state.pending.some(t => `${t.city}|${t.ticker}|${t.forecastDate}|${t.side}` === dupeKey);
        if (isDupe) continue;

        // ── Deduct bankroll on entry ──
        state.bankroll -= cost;

        // ── Enter paper trade ──
        const trade = {
          timestamp: ts,
          city: cityConfig.name,
          citySlug: seriesTicker,
          ticker: parsed.ticker,
          bracket: parsed.subtitle,
          side,
          prob: +tradeProb.toFixed(3),
          ensembleProb: +rawProb.toFixed(3),
          cdfProb: +cdfProb.toFixed(3),
          marketPrice: +parsed.marketPrice.toFixed(3),
          entryPrice: +tradePrice.toFixed(3),
          ev: +tradeEV.toFixed(4),
          edge: +Math.abs(edge).toFixed(3),
          contracts,
          cost,
          bankroll: +state.bankroll.toFixed(2),
          forecastDate,
          forecastMean: +forecastMean.toFixed(1),
          sigma: +sigma.toFixed(2),
          source: best.source,
          memberCount: agreeing,
          status: "PAPER",
          resolved: false,
          peakPrice: tradePrice,
        };

        console.log(`     [TRADE] ${side} ${parsed.subtitle} [${parsed.type}] @ ${(tradePrice * 100).toFixed(0)}c | Prob=${(tradeProb * 100).toFixed(1)}% (${agreeing} members) | EV=${(tradeEV * 100).toFixed(1)}% | ${contracts}x ($${cost}) | src=${best.source}`);
        appendTrade(trade);
        state.pending.push(trade);
        state.totalTrades++;
      }
    } catch (err) {
      console.error(`     [ERR] ${err.message}`);
    }

    await sleep(500); // rate limit between cities
  }

  // ── Check resolutions ──
  await resolveClosedTrades(state);

  // ── Run calibration if we have enough data ──
  runCalibration();

  saveState(state);
  console.log(`\n  Scan complete. Bankroll: $${state.bankroll.toFixed(2)} | Pending: ${state.pending.length} | W/L: ${state.wins}/${state.losses}\n`);
}

// ── Monitor pass: check stops on pending positions (no new entries) ──
async function monitor() {
  const state = loadState();
  if (state.pending.length === 0) return;

  const ts = new Date().toISOString();
  let changed = false;

  for (const trade of state.pending) {
    try {
      // Fetch current market price
      const markets = await fetchOpenMarkets(trade.citySlug || "");
      const market = markets.find(m => m.ticker === trade.ticker);
      if (!market) continue;

      const parsed = parseWeatherMarket(market);
      const currentPrice = parsed.bidPrice || parsed.marketPrice;
      if (!currentPrice) continue;

      // Track peak price for trailing stop
      if (currentPrice > (trade.peakPrice || trade.entryPrice)) {
        trade.peakPrice = currentPrice;
        changed = true;
      }

      // ── Stop loss: price dropped 20% from entry ──
      if (currentPrice <= trade.entryPrice * 0.80) {
        // Recover partial value: sell at current bid price
        const recovered = +(trade.contracts * currentPrice).toFixed(2);
        const pnl = +(recovered - trade.cost).toFixed(2); // net loss
        console.log(`  [STOP-LOSS] ${trade.city} ${trade.bracket} | Entry: ${(trade.entryPrice * 100).toFixed(0)}c → ${(currentPrice * 100).toFixed(0)}c | P&L: $${pnl}`);
        trade.pnl = pnl;
        trade.resolved = true;
        trade.won = false;
        trade.closeReason = "stop_loss";
        state.bankroll += recovered; // Return whatever we can recover (cost was already deducted)
        state.losses++;
        state.resolved.push(trade);
        changed = true;
        continue;
      }

      // ── Trailing stop: price rose 20%+ then fell back to entry ──
      if (trade.peakPrice >= trade.entryPrice * 1.20 && currentPrice <= trade.entryPrice) {
        // Exit at ~breakeven: recover cost
        const recovered = +(trade.contracts * currentPrice).toFixed(2);
        const pnl = +(recovered - trade.cost).toFixed(2);
        console.log(`  [TRAIL-STOP] ${trade.city} ${trade.bracket} | Peak: ${(trade.peakPrice * 100).toFixed(0)}c → ${(currentPrice * 100).toFixed(0)}c | P&L: $${pnl}`);
        trade.pnl = pnl;
        trade.resolved = true;
        trade.won = false;
        trade.closeReason = "trailing_stop";
        state.bankroll += recovered; // Return recovered amount (cost already deducted)
        state.resolved.push(trade);
        changed = true;
        continue;
      }
    } catch (e) {
      // Skip on error
    }
  }

  // Remove resolved trades from pending
  state.pending = state.pending.filter(t => !t.resolved);
  if (changed) saveState(state);
}

// ── Resolve trades that have passed their forecast date ──
async function resolveClosedTrades(state) {
  const stillPending = [];

  for (const trade of state.pending) {
    if (trade.resolved) continue;

    // Only resolve if forecast date has passed
    const forecastEnd = new Date(trade.forecastDate + "T23:59:59Z");
    if (new Date() < forecastEnd) { stillPending.push(trade); continue; }

    const cityKey = Object.keys(config.cities).find(k => config.cities[k].name === trade.city);
    if (!cityKey) { stillPending.push(trade); continue; }
    const city = config.cities[cityKey];

    // Only resolve via NWS actual temperature — never use Kalshi market price (circular logic)
    let actual = await getActualHigh(city.lat, city.lon, trade.forecastDate);

    if (actual === null) {
      // NWS data not available yet — keep waiting (can take 24-48h)
      stillPending.push(trade);
      continue;
    }

    // Determine win/loss
    const parsed = parseWeatherMarket({ ticker: trade.ticker, subtitle: trade.bracket });
    let inBracket;
    if (parsed.type === "above") inBracket = actual >= parsed.bracketLow;
    else if (parsed.type === "below") inBracket = actual <= parsed.bracketHigh;
    else inBracket = actual >= parsed.bracketLow && actual <= parsed.bracketHigh;
    const won = trade.side === "YES" ? inBracket : !inBracket;

    // P&L: profit on win, -cost on loss (for display/logging)
    const profit = +(trade.contracts * (1 - trade.entryPrice)).toFixed(2);
    const pnl = won ? profit : -trade.cost;
    // Since we deducted cost at entry: win returns cost+profit, loss returns nothing
    state.bankroll += won ? (trade.cost + profit) : 0;
    if (won) state.wins++; else state.losses++;
    trade.actualTemp = actual;
    trade.won = won;
    trade.pnl = pnl;
    trade.resolved = true;
    trade.closeReason = "resolution";
    state.resolved.push(trade);

    // Update per-market file
    const slug = (trade.citySlug || cityKey).toLowerCase();
    const mkt = loadMarket(slug, trade.forecastDate);
    if (mkt) {
      mkt.status = "resolved";
      mkt.actual_temp = actual;
      mkt.resolved_outcome = won ? "WIN" : "LOSS";
      mkt.pnl = pnl;
      saveMarket(mkt);
    }

    console.log(`  ${won ? "[WIN]" : "[LOSS]"} ${trade.city} ${trade.bracket} | Actual: ${actual != null ? actual + "F" : "N/A (Kalshi:" + kalshiResult + ")"} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
  }

  state.pending = stillPending;
}

// ── Extract date from Kalshi ticker (e.g., KXHIGHNY-26MAR25-B58 → 2026-03-26) ──
function extractDateFromTicker(ticker) {
  const match = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})-/);
  if (!match) return null;

  const [, day, monthStr, yearShort] = match;
  const months = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
  const month = months[monthStr];
  if (!month) return null;

  return `20${yearShort}-${month}-${day}`;
}

// ── Main entry point ──
async function main() {
  const cmd = process.argv[2];

  if (cmd === "stats") {
    const s = loadState();
    const pnl = s.bankroll - config.startingBankroll;
    const wr = (s.wins + s.losses) > 0 ? (s.wins / (s.wins + s.losses) * 100).toFixed(1) : "0";
    console.log(`\nBankroll: $${s.bankroll.toFixed(2)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(pnl / config.startingBankroll * 100).toFixed(1)}%) | W/L: ${s.wins}/${s.losses} (${wr}%) | Pending: ${s.pending.length}`);
    return;
  }

  if (cmd === "calibration") { generateReport(); return; }

  if (cmd === "reset") {
    const { resetAllData } = require("./storage/logger");
    resetAllData();
    console.log("All data reset to fresh state.");
    return;
  }

  if (cmd === "once") { await scan(); return; }

  console.log(`\nKalshi Weather Paper Trader v2.0`);
  console.log(`  EV threshold: ${config.minEV * 100}% | Kelly: ${config.kellyFraction * 100}% | Max bet: $${config.maxBet}`);
  console.log(`  Max price: ${config.maxPrice * 100}c | Min volume: $${config.minVolume} | Max slippage: ${config.maxSlippage * 100}%`);
  console.log(`  Scan: every ${config.scanInterval}s | Monitor: every ${config.monitorInterval}s\n`);

  await scan();

  // Full scan every scanInterval
  setInterval(() => scan().catch(console.error), config.scanIntervalMs);

  // Quick monitor pass every monitorInterval (stop checks only)
  setInterval(() => monitor().catch(console.error), config.monitorIntervalMs);
}

// Only auto-start when run directly (not when imported by server.js)
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { scan, monitor };
