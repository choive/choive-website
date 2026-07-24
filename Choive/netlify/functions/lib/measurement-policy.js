'use strict';

function boundedCount(value, fallback) {
  return Math.max(1, Math.min(5, Number(value) || fallback));
}

function recommendationSampleCount() {
  return boundedCount(
    process.env.AI_RECOMMENDATION_SAMPLES || process.env.AI_SAMPLES_PER_QUERY,
    3
  );
}

function isRecommendationQuestion(value) {
  var label = typeof value === 'string' ? value : String(value && value.label || '');
  // Only the explicit "which company instead of this subject?" lane needs
  // consensus. Unbranded recommendation questions remain visibility evidence
  // and run once to avoid multiplying cost without changing the named lane.
  return /branded replacement/i.test(label);
}

function samplesForQuestion(value, grounded) {
  if (grounded === false) return 1;
  return isRecommendationQuestion(value) ? recommendationSampleCount() : 1;
}

function strictMajorityThreshold(completed) {
  var count = Math.max(0, Number(completed) || 0);
  return count ? Math.floor(count / 2) + 1 : 0;
}

function completedProviderRuns(runs) {
  return (Array.isArray(runs) ? runs : []).filter(function(run) {
    return run && run.available === true && run.complete === true;
  });
}

module.exports = {
  recommendationSampleCount: recommendationSampleCount,
  isRecommendationQuestion: isRecommendationQuestion,
  samplesForQuestion: samplesForQuestion,
  strictMajorityThreshold: strictMajorityThreshold,
  completedProviderRuns: completedProviderRuns
};
