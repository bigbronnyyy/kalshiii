const config = require("../config");

// ── Fetch open markets for a given series ticker ──
async function fetchOpenMarkets(seriesTicker) {
  const url = `${config.kalshiBase}/markets?series_ticker=${seriesTicker}&status=open&limit=100`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Kalshi error: ${response.status}`);
  const data = await response.json();
  return data.markets || [];
}

// ── Discover all active weather series tickers from Kalshi ──
async function discoverWeatherSeries() {
  const url = `${config.kalshiBase}/markets?status=open&limit=200&series_ticker=KXHIGH`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return Object.keys(config.cities);
    const data = await response.json();
    const markets = data.markets || [];

    // Extract unique series tickers
    const tickers = new Set();
    for (const m of markets) {
      if (m.series_ticker && m.series_ticker.startsWith("KXHIGH")) {
        tickers.add(m.series_ticker);
      }
    }

    // Merge with known cities
    for (const key of Object.keys(config.cities)) {
      tickers.add(key);
    }

    return [...tickers];
  } catch (e) {
    console.warn(`  [!] Discovery failed: ${e.message}, using seed list`);
    return Object.keys(config.cities);
  }
}

// ── Parse a Kalshi weather market into a structured bracket ──
function parseWeatherMarket(market) {
  const subtitle = market.subtitle || "";
  const ticker = market.ticker || "";
  let bracketLow = null, bracketHigh = null, type = "bracket";

  // ── Step 1: Use Kalshi's structured strike_type field (most reliable) ──
  if (market.strike_type) {
    const st = market.strike_type.toLowerCase();
    if (st === "greater" || st === "greater_equal" || st === "above") {
      bracketLow = parseFloat(market.floor_strike);
      bracketHigh = 200;
      type = "above";
    } else if (st === "less" || st === "less_equal" || st === "below") {
      bracketLow = -50;
      bracketHigh = parseFloat(market.cap_strike ?? market.floor_strike);
      type = "below";
    } else if (st === "between") {
      bracketLow = parseFloat(market.floor_strike);
      bracketHigh = parseFloat(market.cap_strike);
      type = "bracket";
    }
  }

  // ── Step 2: Fallback — parse subtitle text ──
  if (bracketLow === null || isNaN(bracketLow)) {
    const rangeMatch = subtitle.match(/(\d+)[°\u00b0\u02da]?F?\s*to\s*(\d+)/i);
    const aboveMatch = subtitle.match(/(\d+)[°\u00b0\u02da]?F?\s*or\s*(higher|above|more)/i);
    const belowMatch = subtitle.match(/(\d+)[°\u00b0\u02da]?F?\s*or\s*(lower|below|less|fewer)/i);

    if (rangeMatch) {
      bracketLow = parseInt(rangeMatch[1]);
      bracketHigh = parseInt(rangeMatch[2]);
      type = "bracket";
    } else if (aboveMatch) {
      bracketLow = parseInt(aboveMatch[1]);
      bracketHigh = 200;
      type = "above";
    } else if (belowMatch) {
      bracketLow = -50;
      bracketHigh = parseInt(belowMatch[1]);
      type = "below";
    }
  }

  // ── Step 3: Fallback — floor_strike / cap_strike without strike_type ──
  if (bracketLow === null && market.floor_strike != null) {
    bracketLow = parseFloat(market.floor_strike);
    bracketHigh = market.cap_strike != null ? parseFloat(market.cap_strike) : 200;
    const subLower = subtitle.toLowerCase();
    if (subLower.includes("below") || subLower.includes("lower") || subLower.includes("or less")) {
      type = "below";
      bracketLow = -50;
      bracketHigh = parseFloat(market.floor_strike);
    } else if (market.cap_strike != null) {
      type = "bracket";
    } else {
      type = "above";
    }
  }

  // ── Step 4: Fallback — parse from ticker ──
  if (bracketLow === null) {
    const bMatch = ticker.match(/B(\d+\.?\d*)/);
    const tMatch = ticker.match(/T(\d+\.?\d*)/);
    if (bMatch) {
      bracketLow = parseFloat(bMatch[1]);
      // Try to extract width from subtitle (e.g., "76° to 78°" → width of 2)
      const subRange = subtitle.match(/(\d+)[°\u00b0]?\s*to\s*(\d+)/i);
      bracketHigh = subRange ? parseInt(subRange[2]) : bracketLow + 2;
      type = "bracket";
    } else if (tMatch) {
      const threshold = parseFloat(tMatch[1]);
      const subLower = subtitle.toLowerCase();
      if (subLower.includes("below") || subLower.includes("lower") || subLower.includes("or less")) {
        bracketLow = -50;
        bracketHigh = threshold;
        type = "below";
      } else {
        bracketLow = threshold;
        bracketHigh = 200;
        type = "above";
      }
    }
  }

  // ── Step 5: Final safety — subtitle overrides contradictions ──
  if (type !== "bracket") {
    const subLower = subtitle.toLowerCase();
    if ((subLower.includes("or below") || subLower.includes("or lower")) && type !== "below") {
      const threshold = bracketLow > 0 ? bracketLow : bracketHigh;
      bracketLow = -50;
      bracketHigh = threshold;
      type = "below";
    } else if ((subLower.includes("or above") || subLower.includes("or higher") || subLower.includes("or more")) && type !== "above") {
      const threshold = bracketHigh < 200 ? bracketHigh : bracketLow;
      bracketLow = threshold;
      bracketHigh = 200;
      type = "above";
    }
  }

  // ── Extract prices: ask (entry), bid (exit), and spread ──
  let askPrice = null, bidPrice = null, marketPrice = null;

  const yad = parseFloat(market.yes_ask_dollars);
  const ybd = parseFloat(market.yes_bid_dollars);
  const lpd = parseFloat(market.last_price_dollars);

  if (yad > 0 && yad < 1) askPrice = yad;
  if (ybd > 0 && ybd < 1) bidPrice = ybd;

  // Best available price for display/logging
  if (ybd > 0 && ybd < 1) marketPrice = ybd;
  else if (lpd > 0 && lpd < 1) marketPrice = lpd;
  else if (yad > 0 && yad < 1) marketPrice = yad;
  // Legacy integer cent fields
  else if (market.yes_bid > 0 && market.yes_bid < 100) marketPrice = market.yes_bid / 100;
  else if (market.last_price > 0 && market.last_price < 100) marketPrice = market.last_price / 100;

  // Spread = ask - bid (if both available)
  const spread = (askPrice != null && bidPrice != null) ? +(askPrice - bidPrice).toFixed(4) : null;

  // ── Close time / expiration ──
  const closeTime = market.close_time || market.expiration_time || null;

  return {
    ticker,
    subtitle,
    type,
    bracketLow,
    bracketHigh,
    marketPrice,
    askPrice,
    bidPrice,
    spread,
    closeTime,
    volume: parseFloat(market.volume_fp || market.volume || 0),
    eventTicker: market.event_ticker,
  };
}

module.exports = { fetchOpenMarkets, discoverWeatherSeries, parseWeatherMarket };
