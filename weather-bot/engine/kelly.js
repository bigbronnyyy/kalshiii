const config = require("../config");

function kellyFraction(prob, marketPrice) {
  if (prob <= 0 || marketPrice <= 0 || marketPrice >= 1) return 0;
  const odds = (1 - marketPrice) / marketPrice;
  const f = (prob * odds - (1 - prob)) / odds;
  return Math.max(0, f);
}

function sizePosition(prob, marketPrice, bankroll) {
  const kelly = kellyFraction(prob, marketPrice);
  const raw = kelly * config.kellyFraction * bankroll;
  return Math.min(raw, bankroll * config.maxPositionPct, config.maxTradeSize);
}

module.exports = { kellyFraction, sizePosition };
