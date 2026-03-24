const { normalCDF } = require("../utils/helpers");

// ── Probability via normal distribution CDF ──
// Smoother than raw ensemble member counting, especially for narrow brackets.
// Uses mean + std from ensemble (or calibrated sigma if available).
function computeProbability(mean, std, bracketLow, bracketHigh, type) {
  if (type === "above") return 1.0 - normalCDF(bracketLow, mean, std);
  if (type === "below") return normalCDF(bracketHigh, mean, std);
  // bracket: P(low <= X <= high)
  return normalCDF(bracketHigh, mean, std) - normalCDF(bracketLow, mean, std);
}

// ── Legacy: raw ensemble member counting (kept for calibration logging) ──
function computeEnsembleProb(maxTemps, bracketLow, bracketHigh, type) {
  const total = maxTemps.length;
  if (total === 0) return 0;

  let count;
  if (type === "above") count = maxTemps.filter(t => t >= bracketLow).length;
  else if (type === "below") count = maxTemps.filter(t => t <= bracketHigh).length;
  else count = maxTemps.filter(t => t >= bracketLow && t <= bracketHigh).length;

  return count / total;
}

// ── Expected Value ──
// EV = p * (1/price - 1) - (1 - p)
// Positive EV = profitable bet over time.
function calcEV(prob, price) {
  if (price <= 0 || price >= 1) return 0.0;
  return prob * (1.0 / price - 1.0) - (1.0 - prob);
}

// ── Raw edge (legacy, kept for logging) ──
function findEdge(ensembleProb, marketPrice) {
  return ensembleProb - marketPrice;
}

module.exports = { computeProbability, computeEnsembleProb, calcEV, findEdge };
