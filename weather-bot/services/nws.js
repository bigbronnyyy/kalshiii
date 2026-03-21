const config = require("../config");

async function getActualHigh(lat, lon, date) {
  try {
    const pointResp = await fetch(`${config.nwsBase}/points/${lat},${lon}`, {
      headers: { "User-Agent": "KalshiPaperTrader/1.0" },
    });
    if (!pointResp.ok) return null;
    const pointData = await pointResp.json();
    const stationsUrl = pointData.properties?.observationStations;
    if (!stationsUrl) return null;

    const stationsResp = await fetch(stationsUrl, {
      headers: { "User-Agent": "KalshiPaperTrader/1.0" },
    });
    if (!stationsResp.ok) return null;
    const stationsData = await stationsResp.json();
    const stationId = stationsData.features?.[0]?.properties?.stationIdentifier;
    if (!stationId) return null;

    const obsUrl = `${config.nwsBase}/stations/${stationId}/observations?start=${date}T00:00:00Z&end=${date}T23:59:59Z`;
    const obsResp = await fetch(obsUrl, {
      headers: { "User-Agent": "KalshiPaperTrader/1.0" },
    });
    if (!obsResp.ok) return null;
    const obsData = await obsResp.json();

    const temps = (obsData.features || [])
      .map(f => f.properties?.maxTemperatureLast24Hours?.value)
      .filter(t => t != null)
      .map(t => t * 9 / 5 + 32);

    return temps.length > 0 ? Math.round(Math.max(...temps)) : null;
  } catch (e) {
    return null;
  }
}

module.exports = { getActualHigh };
