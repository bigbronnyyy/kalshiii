function computeEnsembleProb(maxTemps, bracketLow, bracketHigh, type) {
  const total = maxTemps.length;
  if (total === 0) return 0;

  let count;
  if (type === "above") count = maxTemps.filter(t => t >= bracketLow).length;
  else if (type === "below") count = maxTemps.filter(t => t <= bracketHigh).length;
  else count = maxTemps.filter(t => t >= bracketLow && t <= bracketHigh).length;

  return count / total;
}

function findEdge(ensembleProb, marketPrice) {
  return ensembleProb - marketPrice;
}

module.exports = { computeEnsembleProb, findEdge };
