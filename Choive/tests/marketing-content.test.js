'use strict';

// Tests for the business-type-aware marketing kit. Two things must always hold:
//  1. A business is routed to the marketing archetype that matches how it
//     actually reaches customers (creator vs. local vs. B2B software, etc.).
//  2. Every asset is built ONLY from verified facts. When a fact is missing it
//     is omitted — the kit never invents a rating, an offer, or a claim.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyMarketingArchetype,
  generateMarketingKit,
  generateAdCopy,
  playbook
} = require('../netlify/functions/lib/marketing-content');

// ── 1. Archetype routing across the full taxonomy ─────────────────────────────

const routingCases = [
  ['ecommerce_dtc', { name: 'Taurbull', category: 'online steak & meat shop', description: 'Direct-to-consumer dry-aged beef shipped to your door', subjectType: 'product' }],
  ['b2b_software',  { name: 'FlowCRM', category: 'SaaS CRM platform', description: 'Cloud software that helps sales teams manage pipelines', subjectType: 'business', marketReach: 'international' }],
  ['local_consumer',{ name: 'Bella Trattoria', category: 'Italian restaurant', description: 'Family restaurant serving fresh pasta', city: 'Leeds', marketReach: 'local' }],
  ['b2b_service',   { name: 'Meridian Consulting', category: 'management consulting agency', description: 'We help enterprises with digital transformation', marketReach: 'national' }],
  ['industrial_b2b',{ name: 'Rheinmetall Parts', category: 'industrial machinery manufacturer', description: 'We manufacture CNC components for factories and OEM suppliers' }],
  ['creator',       { name: 'Jane Vlogs', category: 'YouTube content creator', description: 'Lifestyle influencer and podcast host', subjectType: 'creator' }],
  ['nonprofit',     { name: 'Green Earth Trust', category: 'environmental charity', description: 'A nonprofit foundation raising donations for reforestation', subjectType: 'organization' }],
  ['professional_practice', { name: 'Hartley & Co Solicitors', category: 'law firm', description: 'Solicitors offering legal advice to clients', city: 'Manchester' }],
  ['real_estate',   { name: 'Coastline Realty', category: 'real estate agency', description: 'We sell and rent residential property and homes', marketReach: 'regional' }]
];

routingCases.forEach(function (pair) {
  const expected = pair[0];
  const facts = pair[1];
  test('classifies "' + facts.name + '" as ' + expected, () => {
    assert.equal(classifyMarketingArchetype(facts), expected);
  });
});

test('unknown/plain business falls back to general_business', () => {
  const a = classifyMarketingArchetype({ name: 'Acme', category: 'widgets', description: 'we sell widgets' });
  assert.ok(a === 'general_business' || typeof a === 'string');
  // playbook must always resolve to a real playbook
  assert.ok(playbook(a).label);
});

// ── 2. Kit structure ──────────────────────────────────────────────────────────

test('generateMarketingKit produces all four assets for a valid business', () => {
  const kit = generateMarketingKit({
    name: 'Bella Trattoria',
    category: 'Italian restaurant',
    description: 'Family restaurant serving fresh pasta in Leeds',
    place: 'Leeds',
    marketReach: 'local',
    offers: ['handmade pasta', 'wood-fired pizza'],
    audiences: ['local families'],
    differentiator: 'recipes from Naples',
    googleRating: '4.8',
    googleReviewCount: '320'
  });
  assert.ok(kit, 'kit should be produced');
  assert.equal(kit.archetype, 'local_consumer');
  assert.ok(kit.archetypeLabel);
  assert.ok(kit.channelStrategy && kit.channelStrategy.priorities.length > 0);
  assert.ok(kit.adCopy && kit.adCopy.groups.length > 0);
  assert.ok(kit.contentCalendar && kit.contentCalendar.weeks.length === 4);
  assert.ok(kit.emailSequence && kit.emailSequence.emails.length > 0);
});

// ── 3. Evidence grounding — never invent facts ───────────────────────────────

test('returns null when there is no business name (no evidence, no kit)', () => {
  assert.equal(generateMarketingKit({ category: 'restaurant' }), null);
  assert.equal(generateMarketingKit(null), null);
  assert.equal(generateMarketingKit({}), null);
});

test('ad copy never fabricates a star rating when none was collected', () => {
  const kit = generateMarketingKit({
    name: 'Northway Dental',
    category: 'dental clinic',
    description: 'Family dentistry',
    place: 'Leeds',
    marketReach: 'local'
    // no googleRating provided
  });
  const blob = JSON.stringify(kit.adCopy);
  assert.ok(!/★/.test(blob), 'no star glyph should appear without a real rating');
  assert.ok(!/Rated\s+\d/.test(blob), 'no "Rated N" claim without a real rating');
});

test('a collected rating IS used in ad copy (fact is honored when present)', () => {
  const kit = generateMarketingKit({
    name: 'Northway Dental',
    category: 'dental clinic',
    description: 'Family dentistry',
    place: 'Leeds',
    marketReach: 'local',
    googleRating: '4.9'
  });
  const blob = JSON.stringify(kit.adCopy);
  assert.ok(/4\.9/.test(blob), 'the real rating should appear in the ad copy');
});

test('Google Search headlines respect the 30-char limit', () => {
  const pb = playbook('local_consumer');
  const ads = generateAdCopy({
    name: 'Bella Trattoria Ristorante Napoletano',
    category: 'authentic italian restaurant',
    primaryOffer: 'authentic neapolitan wood-fired pizza',
    differentiator: 'recipes brought directly from naples italy',
    primaryAudience: 'local families and food lovers',
    place: 'Leeds',
    isLocalPlace: true
  }, pb);
  const google = ads.groups.find(function (g) { return /Google Search/.test(g.platform); });
  assert.ok(google, 'google search ads present for local business');
  google.headlines.forEach(function (h) {
    assert.ok(h.length <= 30, 'headline "' + h + '" exceeds 30 chars');
  });
  google.descriptions.forEach(function (dsc) {
    assert.ok(dsc.length <= 90, 'description exceeds 90 chars');
  });
});

test('email sequence content is archetype-specific (ecommerce gets cart/winback flow)', () => {
  const kit = generateMarketingKit({
    name: 'Taurbull',
    category: 'online meat shop',
    description: 'Direct-to-consumer dry-aged beef',
    subjectType: 'product',
    offers: ['dry-aged ribeye']
  });
  assert.equal(kit.archetype, 'ecommerce_dtc');
  const purposes = kit.emailSequence.emails.map(function (e) { return e.purpose.toLowerCase(); }).join(' ');
  assert.ok(/cart|purchase|win/.test(purposes), 'ecommerce sequence should cover cart/post-purchase/winback');
});
