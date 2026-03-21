const config = require("../config");

async function fetchEnsembleForecast(lat, lon) {
  const url = `${config.openMeteoBase}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&models=gfs_seamless&temperature_unit=fahrenheit&forecast_days=2&timezone=auto`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo error: ${response.status}`);
  return response.json();
}

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

  return Object.entries(dailyMax).map(([date, memberMaxes]) => ({
    date,
    maxTemps: memberKeys.map(mk => memberMaxes[mk]).filter(t => t > -Infinity),
    memberCount: memberKeys.length,
  })).filter(d => d.maxTemps.length > 0);
}

module.exports = { fetchEnsembleForecast, extractDailyMaxFromEnsemble };
