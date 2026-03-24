const path = require("path");
const fs = require("fs");

// ── Load user-editable trading parameters from config.json ──
const configPath = path.join(__dirname, "config.json");
let userConfig = {};
try {
  userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (e) {
  console.warn("[config] Could not load config.json, using defaults");
}

// ── City seed list with coordinates, ICAO stations, and timezones ──
// Kalshi weather markets use series tickers like KXHIGHNY, KXHIGHCHI, etc.
// Coordinates point to airport stations (matches resolution source).
const CITIES = {
  KXHIGHNY: {
    name: "New York",
    lat: 40.7772,
    lon: -73.8726,
    station: "KLGA",
    unit: "F",
    region: "us",
    timezone: "America/New_York",
    seriesTicker: "KXHIGHNY",
  },
  KXHIGHCHI: {
    name: "Chicago",
    lat: 41.9742,
    lon: -87.9073,
    station: "KORD",
    unit: "F",
    region: "us",
    timezone: "America/Chicago",
    seriesTicker: "KXHIGHCHI",
  },
  KXHIGHMIA: {
    name: "Miami",
    lat: 25.7959,
    lon: -80.2870,
    station: "KMIA",
    unit: "F",
    region: "us",
    timezone: "America/New_York",
    seriesTicker: "KXHIGHMIA",
  },
  KXHIGHAUS: {
    name: "Austin",
    lat: 30.1944,
    lon: -97.6700,
    station: "KAUS",
    unit: "F",
    region: "us",
    timezone: "America/Chicago",
    seriesTicker: "KXHIGHAUS",
  },
  KXHIGHDAL: {
    name: "Dallas",
    lat: 32.8471,
    lon: -96.8518,
    station: "KDAL",
    unit: "F",
    region: "us",
    timezone: "America/Chicago",
    seriesTicker: "KXHIGHDAL",
  },
  KXHIGHSEA: {
    name: "Seattle",
    lat: 47.4502,
    lon: -122.3088,
    station: "KSEA",
    unit: "F",
    region: "us",
    timezone: "America/Los_Angeles",
    seriesTicker: "KXHIGHSEA",
  },
  KXHIGHATL: {
    name: "Atlanta",
    lat: 33.6407,
    lon: -84.4277,
    station: "KATL",
    unit: "F",
    region: "us",
    timezone: "America/New_York",
    seriesTicker: "KXHIGHATL",
  },
  KXHIGHDEN: {
    name: "Denver",
    lat: 39.8561,
    lon: -104.6737,
    station: "KDEN",
    unit: "F",
    region: "us",
    timezone: "America/Denver",
    seriesTicker: "KXHIGHDEN",
  },
  KXHIGHLAX: {
    name: "Los Angeles",
    lat: 33.9425,
    lon: -118.4081,
    station: "KLAX",
    unit: "F",
    region: "us",
    timezone: "America/Los_Angeles",
    seriesTicker: "KXHIGHLAX",
  },
  KXHIGHPHL: {
    name: "Philadelphia",
    lat: 39.8721,
    lon: -75.2411,
    station: "KPHL",
    unit: "F",
    region: "us",
    timezone: "America/New_York",
    seriesTicker: "KXHIGHPHL",
  },
};

module.exports = {
  // City definitions (seed list for known markets)
  cities: CITIES,

  // Trading parameters (from config.json, with defaults)
  balance: userConfig.balance ?? 1000.0,
  maxBet: userConfig.max_bet ?? 20.0,
  minEV: userConfig.min_ev ?? 0.05,
  maxPrice: userConfig.max_price ?? 0.45,
  minVolume: userConfig.min_volume ?? 2000,
  minHours: userConfig.min_hours ?? 2.0,
  maxHours: userConfig.max_hours ?? 72.0,
  kellyFraction: userConfig.kelly_fraction ?? 0.25,
  maxSlippage: userConfig.max_slippage ?? 0.03,
  scanInterval: userConfig.scan_interval ?? 3600,
  monitorInterval: userConfig.monitor_interval ?? 600,
  calibrationMin: userConfig.calibration_min ?? 30,

  // Kept for backward compat
  startingBankroll: userConfig.balance ?? 1000.0,
  minEdge: 0.08, // legacy — now using minEV instead

  // Timing (derived from config.json)
  scanIntervalMs: (userConfig.scan_interval ?? 3600) * 1000,
  monitorIntervalMs: (userConfig.monitor_interval ?? 600) * 1000,

  // File paths
  tradeLogFile: path.join(__dirname, "data/paper_trades.json"),
  calibrationFile: path.join(__dirname, "data/calibration_log.jsonl"),
  calibrationDataFile: path.join(__dirname, "data/calibration.json"),
  stateFile: path.join(__dirname, "data/bot_state.json"),
  marketsDir: path.join(__dirname, "data/markets"),

  // API endpoints
  openMeteoBase: "https://api.open-meteo.com/v1/forecast",
  ensembleBase: "https://ensemble-api.open-meteo.com/v1/ensemble",
  kalshiBase: "https://api.elections.kalshi.com/trade-api/v2",
  nwsBase: "https://api.weather.gov",
  metarBase: "https://aviationweather.gov/api/data/metar",
};
