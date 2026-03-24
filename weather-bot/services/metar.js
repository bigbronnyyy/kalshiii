const config = require("../config");
const { celsiusToFahrenheit } = require("../utils/helpers");

// ── METAR: real-time airport observations ──
// Returns current temperature at the exact station Kalshi uses for resolution.
// Used as supplementary data for D+0 forecasts.
async function fetchMETAR(stationCode) {
  if (!stationCode) return null;

  const url = `${config.metarBase}?ids=${stationCode}&format=json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const data = await response.json();

  if (!Array.isArray(data) || data.length === 0) return null;

  const tempC = data[0]?.temp;
  if (tempC == null) return null;

  return Math.round(celsiusToFahrenheit(tempC));
}

module.exports = { fetchMETAR };
