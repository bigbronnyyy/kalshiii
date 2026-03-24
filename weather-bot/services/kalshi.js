const config = require("../config");

async function fetchOpenMarkets(seriesTicker) {
  const url = `${config.kalshiBase}/markets?series_ticker=${seriesTicker}&status=open&limit=100`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Kalshi error: ${response.status}`);
  const data = await response.json();
  return data.markets || [];
}

function parseWeatherMarket(market) {
  const subtitle = market.subtitle || "";
  const ticker = market.ticker || "";
  let bracketLow = null, bracketHigh = null, type = "bracket";

  // ── Step 1: Use Kalshi's structured strike_type field (most reliable) ──
  // strike_type: "greater" → YES if temp ≥ floor_strike
  // strike_type: "less"    → YES if temp < cap_strike (or ≤)
  // strike_type: "between" → YES if floor_strike ≤ temp ≤ cap_strike
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
  // Handle formats: "49° or below", "49°F or below", "49 or below",
  //                 "77° or higher", "75° to 79°", etc.
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
    // Infer type from subtitle keywords when strike_type is missing
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

  // ── Step 4: Fallback — parse from ticker (e.g. KXHIGHNY-26MAR25-B58, T65) ──
  if (bracketLow === null) {
    const bMatch = ticker.match(/B(\d+\.?\d*)/);
    const tMatch = ticker.match(/T(\d+\.?\d*)/);
    if (bMatch) {
      bracketLow = parseFloat(bMatch[1]);
      bracketHigh = bracketLow + 1;
      type = "bracket";
    } else if (tMatch) {
      const threshold = parseFloat(tMatch[1]);
      // Check subtitle for direction (default to "above" if unclear)
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

  // ── Step 5: Final safety — if subtitle clearly says direction, override ──
  if (type !== "bracket") {
    const subLower = subtitle.toLowerCase();
    if ((subLower.includes("or below") || subLower.includes("or lower")) && type !== "below") {
      // Subtitle says "below" but we parsed as "above" — fix it
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

  // ── Extract best available price ──
  // Kalshi API v2 returns dollar-denominated string fields (e.g. "0.56")
  let marketPrice = null;
  const ybd = parseFloat(market.yes_bid_dollars);
  const lpd = parseFloat(market.last_price_dollars);
  const yad = parseFloat(market.yes_ask_dollars);
  if (ybd > 0 && ybd < 1) marketPrice = ybd;
  else if (lpd > 0 && lpd < 1) marketPrice = lpd;
  else if (yad > 0 && yad < 1) marketPrice = yad;
  // Legacy integer cent fields (deprecated but handle just in case)
  else if (market.yes_bid > 0 && market.yes_bid < 100) marketPrice = market.yes_bid / 100;
  else if (market.last_price > 0 && market.last_price < 100) marketPrice = market.last_price / 100;

  return { ticker, subtitle, type, bracketLow, bracketHigh, marketPrice, volume: parseFloat(market.volume_fp || market.volume || 0), eventTicker: market.event_ticker };
}

module.exports = { fetchOpenMarkets, parseWeatherMarket };
