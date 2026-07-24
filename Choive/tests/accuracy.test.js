
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDeterministicScoring } = require('../netlify/functions/lib/deterministic-scoring');
const { hasValidShape } = require('../netlify/functions/lib/validators');
const { majorityRecommendation } = require('../netlify/functions/lib/recommendation-consensus');
const { samplesForQuestion, strictMajorityThreshold, completedProviderRuns } = require('../netlify/functions/lib/measurement-policy');

function modelResult() {
  const pillar = { score: 19, finding: 'Finding', analysis: 'Analysis', evidence: 'Evidence' };
  return {
    summaryParagraph: 'Summary',
    evidenceNarrative: 'Evidence narrative',
    pillars: {
      clarity: { ...pillar }, trust: { ...pillar }, difference: { ...pillar }, ease: { ...pillar }
    },
    platformCoverage: { chatgpt: 'present', perplexity: 'present', gemini: 'present', claude: 'present' },
    signalAudit: {
      difference: [
        { name: 'Named distinction', status: 'pass', detail: 'Supported' },
        { name: 'Case evidence', status: 'partial', detail: 'Partial' },
        { name: 'Comparison proof', status: 'fail', detail: 'Missing' },
        { name: 'Specific outcome', status: 'pass', detail: 'Supported' }
      ]
    }
  };
}

test('strict result validation rejects non-finite and out-of-range scores', () => {
  const result = modelResult();
  assert.equal(hasValidShape(result), true);
  result.pillars.trust.score = NaN;
  assert.equal(hasValidShape(result), false);
  result.pillars.trust.score = 26;
  assert.equal(hasValidShape(result), false);
});

test('deterministic scores ignore model-proposed numeric scores', () => {
  const evidence = {
    name: 'Example', website: 'example.com', collectedAt: '2026-07-23T00:00:00.000Z',
    websiteText: 'x'.repeat(400),
    websiteSignals: {
      hasTitle: true, titleText: 'Example', hasH1: true, h1Text: 'Example service',
      hasMetaDescription: true, metaDescriptionText: 'A clear description', hasOgTags: true,
      hasCanonical: true, hasSchema: true, hasSpecificSchema: true,
      schemaTypes: ['Organization'], hasLlmsTxt: true, hasSitemap: true,
      hasRobots: true, botCrawlable: true, botEmptyShellDetected: false,
      confirmedReviewPlatforms: []
    },
    searchResults: []
  };
  const first = applyDeterministicScoring(evidence, modelResult());
  const changed = modelResult();
  Object.values(changed.pillars).forEach(pillar => { pillar.score = 1; });
  const second = applyDeterministicScoring(evidence, changed);
  assert.equal(first.overallScore, second.overallScore);
  assert.deepEqual(
    Object.fromEntries(Object.entries(first.pillars).map(([key, value]) => [key, value.score])),
    Object.fromEntries(Object.entries(second.pillars).map(([key, value]) => [key, value.score]))
  );
  assert.equal(first.pillars.clarity.score, 9);
  assert.equal(first.pillars.ease.score, 23);
});

test('every awarded point has a rule and verification trail', () => {
  const scored = applyDeterministicScoring({ name: 'Example', website: 'example.com', websiteSignals: {} }, modelResult());
  for (const rules of Object.values(scored.scoreMethod.audits)) {
    for (const rule of rules) {
      assert.match(rule.ruleId, /^[A-Z]{2}-\d{2}$/);
      assert.equal(typeof rule.points, 'number');
      assert.equal(typeof rule.maxPoints, 'number');
      assert.ok(['mechanical', 'independent', 'model_assessed'].includes(rule.verification));
    }
  }
});

test('missing evidence awards zero instead of inventing positive signals', () => {
  const scored = applyDeterministicScoring({ name: 'Unknown', websiteSignals: {} }, modelResult());
  assert.equal(scored.pillars.clarity.score, 0);
  assert.equal(scored.pillars.trust.score, 0);
  assert.equal(scored.pillars.ease.score, 0);
  assert.equal(scored.pillars.clarity.finding, 'Primary offer and H1 are not established');
});

test('provider recommendation requires majority agreement and normalizes casing', () => {
  const agreed = majorityRecommendation(['Acme AI', 'ACME AI', 'Other'], 3);
  assert.equal(agreed.name, 'Acme AI');
  assert.equal(agreed.count, 2);
  assert.equal(agreed.threshold, 2);

  const split = majorityRecommendation(['Acme', 'Other', 'Third'], 3);
  assert.equal(split.name, null);

  const twoSampleSplit = majorityRecommendation(['Acme'], 2);
  assert.equal(twoSampleSplit.name, null);
  assert.equal(twoSampleSplit.threshold, 2);

  const oneCompleted = majorityRecommendation(['Acme'], 1);
  assert.equal(oneCompleted.name, null);
});

test('consensus merges a brand name with its domain-style spelling', () => {
  const result = majorityRecommendation(['Landpute', 'Landpute.de', 'Gourmetfleisch.de'], 3);
  assert.equal(result.name, 'Landpute');
  assert.equal(result.count, 2);
});

test('empty provider objects do not create review trust points', () => {
  const scored = applyDeterministicScoring({
    name: 'Unknown', website: 'unknown.example', websiteSignals: {},
    trustpilot: {}, googleReviews: {}
  }, modelResult());
  const reviewRules = scored.scoreMethod.audits.trust.filter(rule => /^TR-0[12]$/.test(rule.ruleId));
  assert.equal(reviewRules.reduce((total, rule) => total + rule.points, 0), 0);
});

test('official subdomains do not count as independent trust evidence', () => {
  const scored = applyDeterministicScoring({
    name: 'Example', website: 'https://example.com', websiteSignals: {},
    searchResults: [{
      signalType: 'authority',
      title: 'Example press page',
      snippet: 'Example company announcement',
      link: 'https://press.example.com/announcement'
    }]
  }, modelResult());
  const authorityRule = scored.scoreMethod.audits.trust.find(rule => rule.ruleId === 'TR-03');
  assert.equal(authorityRule.points, 0);
});

test('social profiles and company directories do not earn independent trust points', () => {
  const scored = applyDeterministicScoring({
    name: 'Example', website: 'https://example.com', websiteSignals: {},
    searchResults: [
      { signalType: 'authority', title: 'Example on LinkedIn', snippet: 'Example profile', link: 'https://linkedin.com/company/example' },
      { signalType: 'authority', title: 'Example register record', snippet: 'Example registration', link: 'https://handelsregister.ai/example' },
      { signalType: 'authority', title: 'Example video', snippet: 'Example channel', link: 'https://youtube.com/watch?v=123' }
    ]
  }, modelResult());
  const authorityRule = scored.scoreMethod.audits.trust.find(rule => rule.ruleId === 'TR-03');
  assert.equal(authorityRule.points, 0);
});

test('relevant third-party editorial coverage can earn independent trust points', () => {
  const scored = applyDeterministicScoring({
    name: 'Example', website: 'https://example.com', websiteSignals: {},
    searchResults: [{
      signalType: 'authority',
      title: 'Industry publication reviews Example',
      snippet: 'Independent reporting about Example and its market.',
      link: 'https://industry-publication.test/example-review'
    }]
  }, modelResult());
  const authorityRule = scored.scoreMethod.audits.trust.find(rule => rule.ruleId === 'TR-03');
  assert.ok(authorityRule.points > 0);
});

test('technical metadata is not counted as business clarity', () => {
  const withoutTechnical = applyDeterministicScoring({
    name: 'Example', website: 'example.com', websiteSignals: {}
  }, modelResult());
  const withTechnical = applyDeterministicScoring({
    name: 'Example', website: 'example.com', websiteSignals: {
      hasSchema: true, hasSpecificSchema: true, schemaTypes: ['Organization'],
      hasLlmsTxt: true, hasSitemap: true, hasRobots: true, botCrawlable: true
    }
  }, modelResult());
  assert.equal(withTechnical.pillars.clarity.score, withoutTechnical.pillars.clarity.score);
  assert.ok(withTechnical.pillars.ease.score > withoutTechnical.pillars.ease.score);
});

test('difference points remain labelled as interpreted evidence', () => {
  const scored = applyDeterministicScoring({ name: 'Example', website: 'example.com', websiteSignals: {} }, modelResult());
  assert.ok(scored.scoreMethod.audits.difference.every(rule => rule.verification === 'model_assessed'));
  assert.equal(scored.pillars.difference.confidence.level, 'low');
});

test('sampling repeats only the branded replacement question', () => {
  assert.equal(samplesForQuestion({ label: 'Category discovery' }, true), 1);
  assert.equal(samplesForQuestion({ label: 'Branded replacement' }, true), 3);
  assert.equal(samplesForQuestion({ label: 'Direct recommendation' }, true), 1);
  assert.equal(samplesForQuestion({ label: 'Branded replacement' }, false), 1);
  assert.equal(strictMajorityThreshold(2), 2);
  assert.equal(strictMajorityThreshold(3), 2);
});

test('partial provider runs are excluded from presence and absence headlines', () => {
  const complete = { available: true, complete: true, appearedCount: 1 };
  const partial = { available: true, complete: false, appearedCount: 0 };
  const failed = { available: false, complete: false, appearedCount: 0 };
  assert.deepEqual(completedProviderRuns([complete, partial, failed]), [complete]);
});

test('every pillar rubric totals exactly 25 possible points', () => {
  const scored = applyDeterministicScoring({ name: 'Example', website: 'example.com', websiteSignals: {} }, modelResult());
  for (const [pillar, rules] of Object.entries(scored.scoreMethod.audits)) {
    assert.equal(rules.reduce((total, rule) => total + rule.maxPoints, 0), 25, pillar);
  }
});

test('score bounds remain valid across mechanical signal combinations', () => {
  const keys = ['hasTitle', 'hasH1', 'hasMetaDescription', 'hasSchema', 'hasSpecificSchema', 'hasLlmsTxt', 'hasSitemap', 'hasRobots'];
  for (let mask = 0; mask < (1 << keys.length); mask += 1) {
    const websiteSignals = {};
    keys.forEach((key, index) => { websiteSignals[key] = Boolean(mask & (1 << index)); });
    websiteSignals.botCrawlable = Boolean(mask & 1);
    websiteSignals.botEmptyShellDetected = Boolean(mask & 2);
    const scored = applyDeterministicScoring({
      name: 'Fixture', website: 'fixture.test', websiteSignals
    }, modelResult());
    const pillarScores = Object.values(scored.pillars).map(pillar => pillar.score);
    pillarScores.forEach(value => assert.ok(Number.isFinite(value) && value >= 0 && value <= 25));
    assert.equal(scored.overallScore, pillarScores.reduce((total, value) => total + value, 0));
  }
});
