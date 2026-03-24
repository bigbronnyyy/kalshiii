const config = require("../config");

// ── GFS Seamless (HRRR + GFS blend) via Open-Meteo ──
// Best for US cities at D+0 and D+1. Higher resolution than ECMWF.
// Updates hourly for short-range.
async function fetchHRRR(lat, lon, timezone) {
  const url = `${config.openMeteoBase}`
    + `?latitude=${lat}&longitude=${lon}`
    + `&daily=temperature_2m_max`
    + `&temperature_unit=fahrenheit`
    + `&forecast_days=3`
    + `&timezone=${encodeURIComponent(timezone || "auto")}`
    + `&models=gfs_seamless`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HRRR error: ${response.status}`);
  const data = await response.json();

  if (!data.daily?.time || !data.daily?.temperature_2m_max) return {};

  const result = {};
  for (let i = 0; i < data.daily.time.length; i++) {
    const temp = data.daily.temperature_2m_max[i];
    if (temp != null) {
      result[data.daily.time[i]] = Math.round(temp);
    }
  }
  return result;
}

module.exports = { fetchHRRR };
