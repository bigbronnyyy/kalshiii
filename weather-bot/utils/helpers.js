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

module.exports = { sleep, fahrenheitToCelsius, celsiusToFahrenheit, formatPct };
