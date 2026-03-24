function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fahrenheitToCelsius(f) {
  return (f - 32) * 5 / 9;
}

function celsiusToFahrenheit(c) {
  return c * 9 / 5 + 32;
}

function formatPct(value) {
  return (value * 100).toFixed(1) + "%";
}

// ── Error function approximation (Abramowitz & Stegun) ──
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

// ── Normal CDF: P(X <= x) for X ~ N(mean, std) ──
function normalCDF(x, mean, std) {
  if (std <= 0) return x >= mean ? 1.0 : 0.0;
  const z = (x - mean) / std;
  return 0.5 * (1.0 + erf(z / Math.SQRT2));
}

module.exports = { sleep, fahrenheitToCelsius, celsiusToFahrenheit, formatPct, erf, normalCDF };
