const path = require("path");

module.exports = {
  cities: {
    KXHIGHNY: { name: "New York (Central Park)", lat: 40.7829, lon: -73.9654, seriesTicker: "KXHIGHNY" },
    KXHIGHCHI: { name: "Chicago (Midway)", lat: 41.786, lon: -87.752, seriesTicker: "KXHIGHCHI" },
    KXHIGHMIA: { name: "Miami (MIA)", lat: 25.7959, lon: -80.287, seriesTicker: "KXHIGHMIA" },
    KXHIGHAUS: { name: "Austin (Bergstrom)", lat: 30.1944, lon: -97.67, seriesTicker: "KXHIGHAUS" },
  },

  // Trading parameters
  minEdge: 0.08,           // 8% minimum edge to trigger trade
  kellyFraction: 0.15,     // 15% Kelly (conservative)
  maxPositionPct: 0.05,    // Max 5% of bankroll per trade
  maxTradeSize: 100,       // $100 hard cap per trade
  startingBankroll: 1000,

  // Timing
  scanIntervalMs: 5 * 60 * 1000,  // 5 minutes

  // File paths (resolved relative to this module, not CWD)
  tradeLogFile: path.join(__dirname, "data/paper_trades.json"),
  calibrationFile: path.join(__dirname, "data/calibration_log.jsonl"),
  stateFile: path.join(__dirname, "data/bot_state.json"),

  // API endpoints
  openMeteoBase: "https://api.open-meteo.com/v1/ensemble",
  kalshiBase: "https://api.elections.kalshi.com/trade-api/v2",
  nwsBase: "https://api.weather.gov",
};
