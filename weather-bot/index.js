process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED]", err);
});

const config = require("./config");
const { fetchEnsembleForecast, extractDailyMaxFromEnsemble } = require("./services/ensemble");
const { fetchOpenMarkets, parseWeatherMarket } = require("./services/kalshi");
const { getActualHigh } = require("./services/nws");
const { computeEnsembleProb, findEdge } = require("./engine/edge");
const { sizePosition } = require("./engine/kelly");
const { generateReport } = require("./engine/calibration");
const { loadState, saveState, appendTrade, appendCalibration } = require("./storage/logger");

async function scan() {
  const state = loadState();
  const ts = new Date().toISOString();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  SCAN | ${ts} | Bankroll: $${state.bankroll.toFixed(2)} | W/L: ${state.wins}/${state.losses}`);
  console.log(`${"=".repeat(60)}`);

  for (const [key, city] of Object.entries(config.cities)) {
    console.log(`\n  ${city.name}`);

    try {
      const ensemble = await fetchEnsembleForecast(city.lat, city.lon);
      const dailyMax = extractDailyMaxFromEnsemble(ensemble);
      if (!dailyMax?.length) { console.log("     [!] No ensemble data"); continue; }

      const tomorrow = dailyMax.length > 1 ? dailyMax[1] : dailyMax[0];
      const mean = tomorrow.maxTemps.reduce((a, b) => a + b, 0) / tomorrow.maxTemps.length;
      const std = Math.sqrt(tomorrow.maxTemps.reduce((a, b) => a + (b - mean) ** 2, 0) / tomorrow.maxTemps.length);
      console.log(`     Ensemble: ${tomorrow.memberCount} members | Mean: ${mean.toFixed(1)}F | Std: ${std.toFixed(1)}F`);

      const markets = await fetchOpenMarkets(city.seriesTicker);
      if (!markets.length) { console.log("     [!] No open markets"); continue; }
      console.log(`     Markets: ${markets.length} brackets`);

      for (const market of markets) {
        const parsed = parseWeatherMarket(market);
        if (parsed.bracketLow == null || !parsed.marketPrice) {
          if (!parsed.marketPrice) console.log(`     [SKIP] ${parsed.ticker} | no market price (bracketLow=${parsed.bracketLow})`);
          continue;
        }

        const prob = computeEnsembleProb(tomorrow.maxTemps, parsed.bracketLow, parsed.bracketHigh, parsed.type);
        const edge = findEdge(prob, parsed.marketPrice);

        appendCalibration({ timestamp: ts, city: city.name, ticker: parsed.ticker, bracket: parsed.subtitle, ensembleProb: +prob.toFixed(3), marketPrice: +parsed.marketPrice.toFixed(3), edge: +edge.toFixed(3), memberCount: tomorrow.memberCount, forecastDate: tomorrow.date });

        if (Math.abs(edge) >= config.minEdge) {
          const side = edge > 0 ? "YES" : "NO";
          const tradeProb = edge > 0 ? prob : 1 - prob;
          const tradePrice = edge > 0 ? parsed.marketPrice : 1 - parsed.marketPrice;
          const posSize = sizePosition(tradeProb, tradePrice, state.bankroll);

          if (posSize > 0.5) {
            const contracts = Math.floor(posSize / tradePrice);
            const cost = +(contracts * tradePrice).toFixed(2);
            const dupeKey = `${city.name}|${parsed.ticker}|${tomorrow.date}|${side}`;
            const isDupe = state.pending.some(t => `${t.city}|${t.ticker}|${t.forecastDate}|${t.side}` === dupeKey);
            if (isDupe) continue;
            const trade = { timestamp: ts, city: city.name, ticker: parsed.ticker, bracket: parsed.subtitle, side, ensembleProb: +prob.toFixed(3), marketPrice: +parsed.marketPrice.toFixed(3), edge: +Math.abs(edge).toFixed(3), contracts, cost, forecastDate: tomorrow.date, status: "PAPER", resolved: false };

            console.log(`     [TRADE ENTRY] mode=PAPER | ${side} ${parsed.subtitle} | edge=${(Math.abs(edge)*100).toFixed(1)}% | Would need REAL_TRADING_ENABLED=true + KALSHI_API_KEY + KALSHI_SECRET to go live`);
            appendTrade(trade);
            state.pending.push(trade);
            state.totalTrades++;
            console.log(`     >> ${side} ${parsed.subtitle} @ ${(parsed.marketPrice * 100).toFixed(0)}c | GEFS: ${(prob * 100).toFixed(0)}% | Edge: ${(Math.abs(edge) * 100).toFixed(0)}% | ${contracts} contracts ($${cost})`);
          }
        }
      }
    } catch (err) {
      console.error(`     [ERR] ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1000)); // rate limit
  }

  // Check resolutions
  const stillPending = [];
  for (const trade of state.pending) {
    if (new Date() < new Date(trade.forecastDate)) { stillPending.push(trade); continue; }
    const cityKey = Object.keys(config.cities).find(k => config.cities[k].name === trade.city);
    if (!cityKey) { stillPending.push(trade); continue; }
    const city = config.cities[cityKey];
    const actual = await getActualHigh(city.lat, city.lon, trade.forecastDate);
    if (actual === null) { stillPending.push(trade); continue; }

    const parsed = parseWeatherMarket({ ticker: trade.ticker, subtitle: trade.bracket });
    let inBracket;
    if (parsed.type === "above") inBracket = actual >= parsed.bracketLow;
    else if (parsed.type === "below") inBracket = actual <= parsed.bracketHigh;
    else inBracket = actual >= parsed.bracketLow && actual <= parsed.bracketHigh;

    const won = trade.side === "YES" ? inBracket : !inBracket;
    const payout = trade.side === "YES"
      ? trade.contracts * (1 - trade.marketPrice)
      : trade.contracts * trade.marketPrice;
    const pnl = won ? +payout.toFixed(2) : -trade.cost;
    state.bankroll += pnl;
    if (won) state.wins++; else state.losses++;
    trade.actualTemp = actual; trade.won = won; trade.pnl = pnl; trade.resolved = true;
    state.resolved.push(trade);
    console.log(`  ${won ? "[WIN]" : "[LOSS]"} ${trade.city} ${trade.bracket} | Actual: ${actual}F | P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
  }
  state.pending = stillPending;
  saveState(state);
}

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
  if (cmd === "once") { await scan(); return; }

  console.log(`\nKalshi Weather Paper Trader | Edge: ${config.minEdge * 100}% | Kelly: ${config.kellyFraction * 100}% | Interval: ${config.scanIntervalMs / 1000}s\n`);
  await scan();
  setInterval(() => scan().catch(console.error), config.scanIntervalMs);
}

// Only auto-start when run directly (not when imported by server.js)
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { scan };
