const fs = require("fs");
const config = require("../config");
const { listResolvedMarkets } = require("../storage/markets");

// ── Load calibration data (sigma per city/source) ──
function loadCalibration() {
  try {
    if (fs.existsSync(config.calibrationDataFile)) {
      return JSON.parse(fs.readFileSync(config.calibrationDataFile, "utf8"));
    }
  } catch (e) {}
  return {};
}

// ── Save calibration data ──
function saveCalibration(cal) {
  fs.writeFileSync(config.calibrationDataFile, JSON.stringify(cal, null, 2));
}

// ── Run calibration: compute MAE (sigma) per city/source ──
// Once enough resolved markets exist (calibration_min), the sigma is used
// instead of raw ensemble std for probability estimation.
function runCalibration() {
  const resolved = listResolvedMarkets();
  if (resolved.length === 0) return loadCalibration();

  const cal = loadCalibration();
  const errors = {}; // { "citySlug_source": [error1, error2, ...] }

  for (const mkt of resolved) {
    if (mkt.actual_temp == null) continue;

    for (const snap of (mkt.forecast_snapshots || [])) {
      // Only use the last snapshot before resolution for calibration
      for (const source of ["hrrr", "ecmwf"]) {
        if (snap[source] != null) {
          const key = `${mkt.city}_${source}`;
          if (!errors[key]) errors[key] = [];
          errors[key].push(Math.abs(snap[source] - mkt.actual_temp));
        }
      }
    }
  }

  const now = new Date().toISOString();
  for (const [key, errs] of Object.entries(errors)) {
    if (errs.length >= config.calibrationMin) {
      const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
      cal[key] = {
        sigma: +mae.toFixed(2),
        count: errs.length,
        updated: now,
      };
    }
  }

  saveCalibration(cal);
  return cal;
}

// ── Get calibrated sigma for a city/source (falls back to null) ──
function getCalibratedSigma(citySlug, source) {
  const cal = loadCalibration();
  const entry = cal[`${citySlug}_${source}`];
  return entry?.sigma ?? null;
}

// ── Generate calibration report ──
function generateReport() {
  const cal = loadCalibration();
  const resolved = listResolvedMarkets();

  console.log(`\nCalibration Report`);
  console.log(`Resolved markets: ${resolved.length}\n`);

  if (Object.keys(cal).length === 0) {
    console.log("No calibration data yet. Need at least " + config.calibrationMin + " resolved trades per city/source.");
    return;
  }

  for (const [key, data] of Object.entries(cal)) {
    console.log(`  ${key}: sigma=${data.sigma}°F (${data.count} samples, updated ${data.updated})`);
  }

  // Also show legacy calibration log if it exists
  if (fs.existsSync(config.calibrationFile)) {
    const lines = fs.readFileSync(config.calibrationFile, "utf8")
      .trim().split("\n").filter(Boolean);
    console.log(`\nCalibration log entries: ${lines.length}`);
  }
}

module.exports = { loadCalibration, runCalibration, getCalibratedSigma, generateReport };
