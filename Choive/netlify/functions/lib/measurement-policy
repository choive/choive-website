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
  return /branded replacement|direct recommendation/i.test(label);
}

function samplesForQuestion(value, grounded) {
  if (grounded === false) return 1;
  return isRecommendationQuestion(value) ? recommendationSampleCount() : 1;
}

function strictMajorityThreshold(completed) {
  var count = Math.max(0, Number(completed) || 0);
  return count ? Math.floor(count / 2) + 1 : 0;
}

module.exports = {
  recommendationSampleCount: recommendationSampleCount,
  isRecommendationQuestion: isRecommendationQuestion,
  samplesForQuestion: samplesForQuestion,
  strictMajorityThreshold: strictMajorityThreshold
};
