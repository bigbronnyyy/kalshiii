const fs = require("fs");
const path = require("path");
const config = require("../config");

function ensureDir(filePath) {
  const dir = path.dirname(filePath || config.stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir();
  try {
    if (fs.existsSync(config.stateFile)) {
      return JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    }
  } catch (e) {}
  return { bankroll: config.startingBankroll, totalTrades: 0, wins: 0, losses: 0, pending: [], resolved: [] };
}

function saveState(state) {
  ensureDir();
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

function appendTrade(trade) {
  ensureDir();
  let trades = [];
  try { if (fs.existsSync(config.tradeLogFile)) trades = JSON.parse(fs.readFileSync(config.tradeLogFile, "utf8")); } catch (e) {}
  trades.push(trade);
  fs.writeFileSync(config.tradeLogFile, JSON.stringify(trades, null, 2));
}

function appendCalibration(entry) {
  ensureDir();
  fs.appendFileSync(config.calibrationFile, JSON.stringify(entry) + "\n");
}

module.exports = { loadState, saveState, appendTrade, appendCalibration };
