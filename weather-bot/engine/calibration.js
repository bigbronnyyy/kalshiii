const fs = require("fs");
const config = require("../config");

function generateReport() {
  if (!fs.existsSync(config.calibrationFile)) {
    console.log("No calibration data yet.");
    return;
  }
  const data = fs.readFileSync(config.calibrationFile, "utf8")
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

  console.log(`\nCalibration Report (${data.length} observations)\n`);

  // Edge distribution
  const edges = data.map(d => d.edge);
  const posEdges = edges.filter(e => e > 0);
  const negEdges = edges.filter(e => e < 0);
  const tradeable = edges.filter(e => Math.abs(e) >= config.minEdge);

  console.log(`Positive edges: ${posEdges.length} (avg: ${posEdges.length ? (posEdges.reduce((a, b) => a + b, 0) / posEdges.length * 100).toFixed(1) : 0}%)`);
  console.log(`Negative edges: ${negEdges.length}`);
  console.log(`Tradeable (>${config.minEdge * 100}% edge): ${tradeable.length}`);

  // By city
  console.log(`\nBy City:`);
  const byCity = {};
  for (const d of data) {
    if (!byCity[d.city]) byCity[d.city] = { count: 0, totalEdge: 0 };
    byCity[d.city].count++;
    byCity[d.city].totalEdge += Math.abs(d.edge);
  }
  for (const [city, stats] of Object.entries(byCity)) {
    console.log(`  ${city}: ${stats.count} obs, avg |edge|: ${(stats.totalEdge / stats.count * 100).toFixed(1)}%`);
  }
}

module.exports = { generateReport };
