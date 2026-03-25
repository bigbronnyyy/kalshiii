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

// ── Run calibration: compute actual standard deviation of forecast residuals per city/source ──
// Once enough resolved markets exist (calibration_min), the sigma is used
// instead of raw ensemble std for probability estimation.
// NOTE: We use actual std of residuals, NOT MAE. MAE ≠ σ.
// For reference: σ ≈ MAE × √(π/2) ≈ MAE × 1.2533 for normal distributions.
function runCalibration() {
  const resolved = listResolvedMarkets();
  if (resolved.length === 0) return loadCalibration();

  const cal = loadCalibration();
  const residuals = {}; // { "citySlug_source": [error1, error2, ...] }

  for (const mkt of resolved) {
    if (mkt.actual_temp == null) continue;

    // Use the LAST snapshot before resolution (most recent forecast)
    const snaps = mkt.forecast_snapshots || [];
    const lastSnap = snaps.length > 0 ? snaps[snaps.length - 1] : null;
    if (!lastSnap) continue;

    for (const source of ["hrrr", "ecmwf"]) {
      if (lastSnap[source] != null) {
        const key = `${mkt.city}_${source}`;
        if (!residuals[key]) residuals[key] = [];
        residuals[key].push(lastSnap[source] - mkt.actual_temp); // signed residual
      }
    }
  }

  const now = new Date().toISOString();
  for (const [key, errs] of Object.entries(residuals)) {
    if (errs.length >= config.calibrationMin) {
      // Compute actual standard deviation (not MAE)
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      const variance = errs.reduce((a, b) => a + (b - mean) ** 2, 0) / (errs.length - 1);
      const std = Math.sqrt(variance);
      const bias = mean; // systematic bias (positive = forecast runs hot)
      cal[key] = {
        sigma: +std.toFixed(2),
        bias: +bias.toFixed(2),
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
