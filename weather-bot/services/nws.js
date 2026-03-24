const config = require("../config");

// ── Get actual high temperature from NWS for a given date ──
// Uses individual hourly observations and converts C → F.
async function getActualHigh(lat, lon, date) {
  try {
    const pointResp = await fetch(`${config.nwsBase}/points/${lat},${lon}`, {
      headers: { "User-Agent": "KalshiPaperTrader/2.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!pointResp.ok) return null;
    const pointData = await pointResp.json();
    const stationsUrl = pointData.properties?.observationStations;
    if (!stationsUrl) return null;

    const stationsResp = await fetch(stationsUrl, {
      headers: { "User-Agent": "KalshiPaperTrader/2.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!stationsResp.ok) return null;
    const stationsData = await stationsResp.json();
    const stationId = stationsData.features?.[0]?.properties?.stationIdentifier;
    if (!stationId) return null;

    const obsUrl = `${config.nwsBase}/stations/${stationId}/observations?start=${date}T00:00:00Z&end=${date}T23:59:59Z`;
    const obsResp = await fetch(obsUrl, {
      headers: { "User-Agent": "KalshiPaperTrader/2.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!obsResp.ok) return null;
    const obsData = await obsResp.json();

    const temps = (obsData.features || [])
      .map(f => f.properties?.temperature?.value)
      .filter(t => t != null)
      .map(t => t * 9 / 5 + 32);

    return temps.length > 0 ? Math.round(Math.max(...temps)) : null;
  } catch (e) {
    return null;
  }
}

// ── Fallback: check Kalshi market status for resolution ──
// If market is closed and YES price >= 0.95, it resolved YES (WIN).
// If <= 0.05, resolved NO (LOSS).
async function checkKalshiResolution(ticker) {
  try {
    const url = `${config.kalshiBase}/markets/${ticker}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json();
    const market = data.market;
    if (!market || market.status !== "closed") return null;

    const result = market.result;
    if (result === "yes") return "WIN";
    if (result === "no") return "LOSS";

    // Fallback: check final price
    const lastPrice = parseFloat(market.last_price_dollars || 0);
    if (lastPrice >= 0.95) return "WIN";
    if (lastPrice <= 0.05) return "LOSS";
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { getActualHigh, checkKalshiResolution };
