'use strict';

// Tests for the shared business-archetype classifier and its profiles, plus a
// check that the fix plan re-orders fixes by what matters most for the type.
// Two guarantees: every business routes to the archetype that matches how it
// actually wins customers, and the profile weights only change ORDER, never the
// point impact or the score.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBusinessArchetype,
  getArchetypeProfile,
  ARCHETYPES,
  ARCHETYPE_PROFILES
} = require('../netlify/functions/lib/business-archetype');
const { buildFixPlan } = require('../netlify/functions/lib/fix-plan');

// ── 1. Routing across the taxonomy ────────────────────────────────────────────

const routing = [
  ['ecommerce_dtc', { name: 'Taurbull', category: 'online steak & meat shop', description: 'Direct-to-consumer dry-aged beef shipped to your door', subjectType: 'product' }],
  ['b2b_software',  { name: 'FlowCRM', category: 'SaaS CRM platform', description: 'Cloud software that helps sales teams manage pipelines', marketReach: 'international' }],
  ['local_consumer',{ name: 'Bella Trattoria', category: 'Italian restaurant', description: 'Family restaurant serving fresh pasta', city: 'Leeds', marketReach: 'local' }],
  ['b2b_service',   { name: 'Meridian Consulting', category: 'management consulting agency', description: 'We help enterprises with digital transformation', marketReach: 'national' }],
  ['industrial_b2b',{ name: 'Rheinmetall Parts', category: 'industrial machinery manufacturer', description: 'We manufacture CNC components for factories and OEM suppliers' }],
  ['creator',       { name: 'Jane Vlogs', category: 'YouTube content creator', description: 'Lifestyle influencer and podcast host', subjectType: 'creator' }],
  ['nonprofit',     { name: 'Green Earth Trust', category: 'environmental charity', description: 'A nonprofit foundation raising donations for reforestation', subjectType: 'organization' }],
  ['professional_practice', { name: 'Hartley & Co Solicitors', category: 'law firm', description: 'Solicitors offering legal advice to clients', city: 'Manchester' }],
  ['real_estate',   { name: 'Coastline Realty', category: 'real estate agency', description: 'We sell and rent residential property and homes', marketReach: 'regional' }],
  ['general_business', { name: 'Acme', category: 'widgets', description: 'we make widgets' }]
];

routing.forEach(function (pair) {
  test('classifyBusinessArchetype: "' + pair[1].name + '" → ' + pair[0], () => {
    assert.equal(classifyBusinessArchetype(pair[1]), pair[0]);
  });
});

test('classifier reads inferredCategory when category is absent', () => {
  assert.equal(classifyBusinessArchetype({ inferredCategory: 'Italian restaurant', marketReach: 'local' }), 'local_consumer');
});

// ── 2. Profiles ───────────────────────────────────────────────────────────────

test('every archetype has a profile with 4 pillar weights (1–3) and a note', () => {
  ARCHETYPES.forEach(function (a) {
    const p = getArchetypeProfile(a);
    assert.ok(p, 'profile exists for ' + a);
    assert.equal(typeof p.label, 'string');
    assert.equal(typeof p.emphasisNote, 'string');
    ['clarity', 'trust', 'difference', 'ease'].forEach(function (pillar) {
      const w = p.pillarEmphasis[pillar];
      assert.ok(w >= 1 && w <= 3, a + '.' + pillar + ' weight in range');
    });
  });
});

test('getArchetypeProfile falls back to general_business for an unknown key', () => {
  assert.deepEqual(getArchetypeProfile('nonsense'), ARCHETYPE_PROFILES.general_business);
});

// ── 3. Fix-plan re-ordering by archetype (order changes, impact does not) ─────

function resultWithTwoFixes() {
  // A clarity fix worth slightly MORE points and a trust fix worth slightly
  // less. For a local_consumer (trust weight 3 vs clarity weight 2), the trust
  // fix should still be surfaced first because it matters more for that type.
  // difference and ease are kept at full credit (score 25, gap 0) so no fix card
  // is generated for them. That leaves exactly two competing fixes: a clarity
  // fix worth 6 points and a trust fix worth 5 points. Their ORDER is what the
  // archetype weighting decides — the point impacts never change.
  return {
    overallScore: 60,
    pillars: {
      clarity: { score: 15 }, trust: { score: 12 }, difference: { score: 25 }, ease: { score: 25 }
    },
    scoreMethod: {
      audits: {
        clarity: [{ ruleId: 'CL-01', label: 'Homepage headline is clear', points: 6, maxPoints: 12, verification: 'mechanical', observed: 'Headline is vague', source: '' }],
        trust:   [{ ruleId: 'TR-01', label: 'Enough recent reviews', points: 6, maxPoints: 11, verification: 'independent', observed: 'Few reviews found', source: '' }],
        difference: [{ ruleId: 'DF-01', label: 'Clear point of difference', points: 25, maxPoints: 25, verification: 'mechanical', observed: 'Strong differentiator stated', source: '' }],
        ease:       [{ ruleId: 'EA-01', label: 'Easy to contact and buy', points: 25, maxPoints: 25, verification: 'mechanical', observed: 'Clear contact and checkout', source: '' }]
      }
    },
    actions: []
  };
}

test('local_consumer archetype surfaces the trust/review fix first', () => {
  const r = resultWithTwoFixes();
  r.archetype = 'local_consumer';
  r.archetypeProfile = getArchetypeProfile('local_consumer');
  const plan = buildFixPlan(r);
  assert.ok(plan.available);
  assert.equal(plan.fixes[0].pillar, 'trust', 'trust fix ranked first for a local business');
  assert.ok(plan.archetypeEmphasis && /Local business/.test(plan.archetypeEmphasis.label));
});

test('b2b_software archetype surfaces the clarity fix first', () => {
  const r = resultWithTwoFixes();
  r.archetype = 'b2b_software';
  r.archetypeProfile = getArchetypeProfile('b2b_software');
  const plan = buildFixPlan(r);
  assert.equal(plan.fixes[0].pillar, 'clarity', 'clarity fix ranked first for a software company');
});

test('point impact values are identical regardless of archetype (only order changes)', () => {
  const rLocal = resultWithTwoFixes(); rLocal.archetype = 'local_consumer'; rLocal.archetypeProfile = getArchetypeProfile('local_consumer');
  const rSoft = resultWithTwoFixes(); rSoft.archetype = 'b2b_software'; rSoft.archetypeProfile = getArchetypeProfile('b2b_software');
  const impactByPillar = function (plan) {
    const m = {}; plan.fixes.forEach(function (f) { m[f.pillar] = f.pointImpact; }); return m;
  };
  assert.deepEqual(impactByPillar(buildFixPlan(rLocal)), impactByPillar(buildFixPlan(rSoft)));
});

test('with no archetype the fix plan still works and archetypeEmphasis is null', () => {
  const plan = buildFixPlan(resultWithTwoFixes());
  assert.ok(plan.available);
  assert.equal(plan.archetypeEmphasis, null);
  // Without emphasis, the higher-impact clarity fix (6 pts) ranks above trust (5 pts).
  assert.equal(plan.fixes[0].pillar, 'clarity');
});
