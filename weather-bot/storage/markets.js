const fs = require("fs");
const path = require("path");
const config = require("../config");

function ensureMarketsDir() {
  if (!fs.existsSync(config.marketsDir)) {
    fs.mkdirSync(config.marketsDir, { recursive: true });
  }
}

function marketFilePath(citySlug, dateStr) {
  return path.join(config.marketsDir, `${citySlug}_${dateStr}.json`);
}

function loadMarket(citySlug, dateStr) {
  const filePath = marketFilePath(citySlug, dateStr);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {}
  return null;
}

function saveMarket(mkt) {
  ensureMarketsDir();
  const filePath = marketFilePath(mkt.city, mkt.date);
  fs.writeFileSync(filePath, JSON.stringify(mkt, null, 2));
}

function newMarket(citySlug, cityName, dateStr) {
  return {
    city: citySlug,
    city_name: cityName,
    date: dateStr,
    status: "open",
    position: null,
    actual_temp: null,
    resolved_outcome: null,
    pnl: null,
    forecast_snapshots: [],
    market_snapshots: [],
    all_outcomes: [],
    created_at: new Date().toISOString(),
  };
}

function listMarkets() {
  ensureMarketsDir();
  const files = fs.readdirSync(config.marketsDir).filter(f => f.endsWith(".json"));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(config.marketsDir, f), "utf8")); }
    catch (e) { return null; }
  }).filter(Boolean);
}

function listResolvedMarkets() {
  return listMarkets().filter(m => m.status === "resolved");
}

module.exports = { loadMarket, saveMarket, newMarket, listMarkets, listResolvedMarkets };
