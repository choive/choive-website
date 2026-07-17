'use strict';

// The browser should never receive paid-only analysis for an unpaid job.
// Keep the free verdict, scores, competitor names, and attributed provider
// recommendations while removing evidence, actions, transcripts, and assets.
function buildPublicResult(result) {
  var source = result && typeof result === 'object' ? result : {};
  var publicResult = Object.assign({}, source);

  [
    'actions',
    'aiSimulation',
    'apifyText',
    'businessUnderstanding',
    'competitorApify',
    'competitorComparison',
    'deliverables',
    'evidenceNarrative',
    'googleReviews',
    'platformSimulations',
    'reviewText',
    'signalAudit',
    'socialSignals',
    'summaries',
    'trustpilot'
  ].forEach(function(key) {
    delete publicResult[key];
  });

  if (source.pillars && typeof source.pillars === 'object') {
    publicResult.pillars = {};
    ['clarity', 'trust', 'difference', 'ease'].forEach(function(key) {
      var pillar = source.pillars[key] || {};
      publicResult.pillars[key] = { score: Number(pillar.score) || 0 };
    });
  }

  publicResult.competitors = Array.isArray(source.competitors)
    ? source.competitors.filter(function(item) {
        return item && item.name;
      }).map(function(item) {
        return {
          name: String(item.name),
          queryContext: String(item.queryContext || '')
        };
      })
    : [];

  return publicResult;
}

module.exports = { buildPublicResult: buildPublicResult };
