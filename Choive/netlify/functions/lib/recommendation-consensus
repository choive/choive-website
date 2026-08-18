'use strict';

const { strictMajorityThreshold } = require('./measurement-policy');

function normalizeName(value) {
  var text = String(value || '').toLowerCase();
  try { text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  // Providers may return the same brand as a name or as its domain.
  text = text
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.(?:com|de|net|org|io|ai|co\.uk|co|eu|tv|app)\/?$/i, '');
  return text.replace(/\u00df/g, 'ss').replace(/[^a-z0-9]+/g, '');
}

function majorityRecommendation(names, completedSamples) {
  var counts = {};
  var displayNames = {};
  (Array.isArray(names) ? names : []).forEach(function(name) {
    var key = normalizeName(name);
    if (!key) return;
    displayNames[key] = displayNames[key] || String(name).trim();
    counts[key] = (counts[key] || 0) + 1;
  });
  var ranked = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; });
  var completed = Math.max(0, Number(completedSamples) || 0);
  // A majority is strictly more than half. Math.ceil(n / 2) incorrectly
  // accepts a 1-1 split when two samples complete.
  var threshold = strictMajorityThreshold(completed);
  var winnerKey = ranked[0] && completed >= 2 && counts[ranked[0]] >= threshold
    ? ranked[0] : null;
  return {
    name: winnerKey ? displayNames[winnerKey] : null,
    count: winnerKey ? counts[winnerKey] : 0,
    completedSamples: completed,
    threshold: threshold,
    counts: counts
  };
}

module.exports = { majorityRecommendation: majorityRecommendation, normalizeName: normalizeName };
