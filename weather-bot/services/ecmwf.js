const config = require("../config");

// ── ECMWF IFS025 via Open-Meteo (global, bias-corrected, 7-day) ──
// The gold standard for weather prediction. Free via Open-Meteo.
// Updates ~6 UTC and ~18 UTC.
async function fetchECMWF(lat, lon, timezone) {
  const url = `${config.openMeteoBase}`
    + `?latitude=${lat}&longitude=${lon}`
    + `&daily=temperature_2m_max`
    + `&temperature_unit=fahrenheit`
    + `&forecast_days=7`
    + `&timezone=${encodeURIComponent(timezone || "auto")}`
    + `&models=ecmwf_ifs025`
    + `&bias_correction=true`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`ECMWF error: ${response.status}`);
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

module.exports = { fetchECMWF };
