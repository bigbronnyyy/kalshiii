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

  const rangeMatch = subtitle.match(/(\d+)°?\s*to\s*(\d+)°?/i);
  const aboveMatch = subtitle.match(/(\d+)°?\s*or\s*(higher|above)/i);
  const belowMatch = subtitle.match(/(\d+)°?\s*or\s*(lower|below)/i);

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

  // Use floor_strike and cap_strike if available (Kalshi structured data)
  if (bracketLow === null && market.floor_strike != null) {
    bracketLow = parseFloat(market.floor_strike);
    bracketHigh = market.cap_strike != null ? parseFloat(market.cap_strike) : 200;
    type = market.cap_strike != null ? "bracket" : "above";
  }

  // Backup: parse from ticker format KXHIGHNY-26MAR21-B58 or T65
  if (bracketLow === null) {
    const bMatch = ticker.match(/B(\d+\.?\d*)/);
    const tMatch = ticker.match(/T(\d+\.?\d*)/);
    if (bMatch) { bracketLow = parseFloat(bMatch[1]); bracketHigh = bracketLow + 1; type = "bracket"; }
    else if (tMatch) { bracketLow = parseFloat(tMatch[1]); bracketHigh = 200; type = "above"; }
  }

  // Extract best available price
  // Kalshi API v2 returns dollar-denominated string fields (e.g. "0.56")
  // Fallback chain: yes_bid_dollars → last_price_dollars → yes_ask_dollars → legacy fields
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
