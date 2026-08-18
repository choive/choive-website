'use strict';

// Focused tests for the two deliverables added for "highest value": a
// ready-to-send review-request email and a Google Business Profile description.
// Both must be built only from recorded facts, never fabricate a review or a
// customer, and must return null when they do not apply.

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDeliverables } = require('../netlify/functions/lib/deliverables');

function modelResult() {
  const pillar = { score: 12, finding: 'Finding', analysis: 'Analysis', evidence: 'Evidence' };
  return {
    summaryParagraph: 'Summary',
    pillars: {
      clarity: { ...pillar }, trust: { ...pillar }, difference: { ...pillar }, ease: { ...pillar }
    },
    actions: [],
    scoreMethod: { audits: { trust: [] } }
  };
}

// ── Review-request email ──────────────────────────────────────────────────

test('review email is built for a local review-platform business, from real facts and safe placeholders', () => {
  const evidence = {
    name: 'Northway Dental',
    category: 'dental clinic',
    description: 'Northway Dental provides family and cosmetic dentistry in Leeds.',
    city: 'Leeds',
    marketReach: 'local',
    website: 'https://northwaydental.example',
    websiteSignals: {}
  };
  const result = modelResult();
  result.inferredCategory = evidence.category;

  const d = generateDeliverables(evidence, result);
  const email = d.reviewEmailTemplate;

  assert.ok(email, 'email should be produced for a review-platform business');
  assert.equal(typeof email.subject, 'string');
  assert.equal(typeof email.body, 'string');
  // Uses the real business name.
  assert.match(email.subject, /Northway Dental/);
  assert.match(email.body, /Northway Dental/);
  // Everything a person must personalise is a clearly marked placeholder.
  assert.match(email.body, /\[Customer name\]/);
  assert.match(email.body, /\[Your name\]/);
  assert.match(email.body, /\[Paste your .* review link here\]/);
  // Uses the real, category-matched platform (local business => Google Reviews).
  assert.equal(email.platform, 'Google Reviews');
  // Never invents a testimonial or fake quote.
  assert.match(email.body, /honest/i);
});

test('review email is null when the category does not use a public review platform', () => {
  const evidence = {
    name: '3 Screen Solutions',
    category: 'B2B pay-TV middleware for operators and automotive OEMs',
    description: '3 Screen Solutions licenses multiscreen software to pay-TV operators worldwide.',
    marketReach: 'global',
    website: 'https://3ss.tv',
    websiteSignals: {}
  };
  const result = modelResult();
  result.inferredCategory = evidence.category;

  const d = generateDeliverables(evidence, result);
  assert.equal(d.reviewEmailTemplate, null);
  // The review action itself must be flagged as not a review platform.
  assert.equal(d.reviewAction.isReviewPlatform, false);
});

// ── Google Business Profile description ────────────────────────────────────

test('GBP description is built only from recorded facts and respects the 750-character cap', () => {
  const evidence = {
    name: 'Northway Dental',
    category: 'dental clinic',
    description: 'Northway Dental provides family and cosmetic dentistry in Leeds.',
    city: 'Leeds',
    marketReach: 'local',
    website: 'https://northwaydental.example',
    websiteSignals: {}
  };
  const result = modelResult();
  result.inferredCategory = evidence.category;

  const d = generateDeliverables(evidence, result);
  const gbp = d.gbpDesc;

  assert.ok(gbp, 'GBP description should be produced for a place-based business');
  assert.equal(typeof gbp.text, 'string');
  assert.match(gbp.text, /Northway Dental/);
  assert.match(gbp.text, /Leeds/);
  assert.equal(gbp.maxChars, 750);
  assert.ok(gbp.text.length <= 750, 'text must never exceed the Google cap');
  assert.equal(gbp.charCount, gbp.text.length);
  // No fabricated superlatives.
  assert.doesNotMatch(gbp.text, /best|number one|leading|award-winning|world-class/i);
});

test('GBP description is null when there is no place to anchor it', () => {
  const evidence = {
    name: 'Northway Dental',
    category: 'dental clinic',
    description: 'Northway Dental provides family and cosmetic dentistry.',
    marketReach: 'local',
    website: 'https://northwaydental.example',
    websiteSignals: {}
  };
  const result = modelResult();
  result.inferredCategory = evidence.category;

  const d = generateDeliverables(evidence, result);
  assert.equal(d.gbpDesc, null);
});

test('GBP description is null for a national/online business even when a city is recorded', () => {
  const evidence = {
    name: 'Taurbull',
    category: 'online meat retailer',
    description: 'Taurbull delivers dry-aged beef across Germany.',
    city: 'Stuttgart, Germany',
    marketReach: 'national',
    website: 'https://taurbull.example',
    websiteSignals: {}
  };
  const result = modelResult();
  result.inferredCategory = evidence.category;

  const d = generateDeliverables(evidence, result);
  assert.equal(d.gbpDesc, null);
});
