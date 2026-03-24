const config = require("../config");

// ── GFS 31-member ensemble from Open-Meteo ──
// Used for probability distribution estimation (mean + std).
// The ensemble spread gives us the forecast uncertainty (sigma).
async function fetchEnsembleForecast(lat, lon, forecastDays) {
  const days = forecastDays || 3;
  const url = `${config.ensembleBase}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&models=gfs_seamless&temperature_unit=fahrenheit&forecast_days=${days}&timezone=auto`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Open-Meteo ensemble error: ${response.status}`);
  return response.json();
}

// ── Extract daily max temperature per ensemble member ──
function extractDailyMaxFromEnsemble(data) {
  if (!data?.hourly) return null;

  const times = data.hourly.time;
  const memberKeys = Object.keys(data.hourly).filter(k => k.startsWith("temperature_2m_member"));
  if (memberKeys.length === 0) return null;

  const dailyMax = {};

  for (let i = 0; i < times.length; i++) {
    const date = times[i].split("T")[0];
    if (!dailyMax[date]) {
      dailyMax[date] = memberKeys.reduce((acc, mk) => ({ ...acc, [mk]: -Infinity }), {});
    }
    for (const mk of memberKeys) {
      const temp = data.hourly[mk][i];
      if (temp != null && temp > dailyMax[date][mk]) {
        dailyMax[date][mk] = temp;
      }
    }
  }

  return Object.entries(dailyMax).map(([date, memberMaxes]) => {
    const maxTemps = memberKeys.map(mk => memberMaxes[mk]).filter(t => t > -Infinity);
    const mean = maxTemps.length > 0 ? maxTemps.reduce((a, b) => a + b, 0) / maxTemps.length : null;
    const std = maxTemps.length > 1
      ? Math.sqrt(maxTemps.reduce((a, b) => a + (b - mean) ** 2, 0) / maxTemps.length)
      : null;
    return {
      date,
      maxTemps,
      memberCount: memberKeys.length,
      mean: mean != null ? +mean.toFixed(1) : null,
      std: std != null ? +std.toFixed(2) : null,
    };
  }).filter(d => d.maxTemps.length > 0);
}

module.exports = { fetchEnsembleForecast, extractDailyMaxFromEnsemble };
