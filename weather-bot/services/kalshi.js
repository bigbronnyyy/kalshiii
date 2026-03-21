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
  let marketPrice = null;
  if (market.yes_bid > 0 && market.yes_bid < 99) marketPrice = market.yes_bid / 100;
  else if (market.last_price > 0 && market.last_price < 99) marketPrice = market.last_price / 100;

  return { ticker, subtitle, type, bracketLow, bracketHigh, marketPrice, volume: market.volume, eventTicker: market.event_ticker };
}

module.exports = { fetchOpenMarkets, parseWeatherMarket };
