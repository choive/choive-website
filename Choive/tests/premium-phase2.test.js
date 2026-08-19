'use strict';

// Tests for the Phase 2 premium report modules:
//   - roi-projection: honest, owner-driven what-if (no invented revenue)
//   - competitor-strategy: evidence-only "how to win" (no invented competitor facts)
//   - seo-keywords: real buyer phrases grounded in category/location/rivals (no fake volumes)

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRoiModel } = require('../netlify/functions/lib/roi-projection');
const { buildCompetitorStrategy } = require('../netlify/functions/lib/competitor-strategy');
const { buildKeywordStrategy } = require('../netlify/functions/lib/seo-keywords');

// ── ROI projection ────────────────────────────────────────────────────────────

test('roi: unavailable when there is no real score', () => {
  assert.equal(buildRoiModel({}).available, false);
  assert.equal(buildRoiModel({ overallScore: 0 }).available, false);
});

test('roi: builds an honest framework with example scenarios and a disclaimer', () => {
  const m = buildRoiModel({ overallScore: 55 });
  assert.equal(m.available, true);
  assert.equal(m.currentScore, 55);
  assert.equal(m.headroom, 45);
  assert.ok(Array.isArray(m.scenarios) && m.scenarios.length === 3);
  m.scenarios.forEach(function (s) {
    assert.ok(s.exampleExtraCustomers >= 1, 'example customers is a positive integer');
    assert.match(s.note, /example/i);
  });
  // The disclaimer must make clear these are not promises.
  assert.match(m.disclaimer, /not (a )?promise/i);
  assert.ok(m.inputs.length === 2, 'owner supplies value + customers');
});

test('roi: never fabricates a money figure (no currency/number promised in copy)', () => {
  const m = buildRoiModel({ overallScore: 70 });
  // The module output must not contain a concrete money projection — money math
  // happens only in the browser from owner input.
  const blob = JSON.stringify(m);
  assert.ok(!/[£$€]\s?\d/.test(blob), 'no concrete currency amount is asserted');
});

test('roi: example customer counts shrink when there is little headroom', () => {
  const low = buildRoiModel({ overallScore: 95 });   // headroom 5
  const high = buildRoiModel({ overallScore: 40 });  // headroom 60
  const bigLow = low.scenarios.find(s => s.key === 'big').exampleExtraCustomers;
  const bigHigh = high.scenarios.find(s => s.key === 'big').exampleExtraCustomers;
  assert.ok(bigLow <= bigHigh, 'less room to improve => smaller example');
});

// ── Competitor strategy ─────────────────────────────────────────────────────

test('competitor-strategy: unavailable with no competitor data and no pillars', () => {
  assert.equal(buildCompetitorStrategy({}).available, false);
});

test('competitor-strategy: surfaces the AI-named competitor with only the recorded reason', () => {
  const cs = buildCompetitorStrategy({
    displacement: { competitorName: 'Otto Gourmet', competitorWhy: 'It had many recent reviews.' },
    pillars: {
      clarity: { score: 20 }, trust: { score: 8, finding: 'Few reviews found.' },
      difference: { score: 15 }, ease: { score: 12 }
    }
  });
  assert.equal(cs.available, true);
  assert.equal(cs.namedByAI.name, 'Otto Gourmet');
  assert.match(cs.namedByAI.why, /recent reviews/);
  // Weakest pillar (trust, score 8) must be the first win-move.
  assert.equal(cs.winMoves[0].pillar, 'trust');
});

test('competitor-strategy: does not invent a reason when none was recorded', () => {
  const cs = buildCompetitorStrategy({
    displacement: { competitorName: 'RivalCo' },
    pillars: { clarity: { score: 10 }, trust: { score: 20 }, difference: { score: 20 }, ease: { score: 20 } }
  });
  assert.equal(cs.namedByAI.name, 'RivalCo');
  assert.equal(cs.namedByAI.why, '', 'empty when not recorded — never fabricated');
});

test('competitor-strategy: dedupes search competitors and drops the already-named one', () => {
  const cs = buildCompetitorStrategy({
    displacement: { competitorName: 'Otto Gourmet' },
    competitors: [
      { domain: 'ottogourmet.de', title: 'Otto Gourmet' },
      { domain: 'kreutzers.de', title: 'Kreutzers' },
      { domain: 'kreutzers.de', title: 'Kreutzers dup' }
    ],
    pillars: { clarity: { score: 10 }, trust: { score: 10 }, difference: { score: 10 }, ease: { score: 10 } }
  });
  const domains = cs.alsoSeen.map(a => a.domain);
  assert.deepEqual(domains, ['ottogourmet.de', 'kreutzers.de']);
});

// ── SEO keyword strategy ────────────────────────────────────────────────────

test('seo: unavailable with no category', () => {
  assert.equal(buildKeywordStrategy({}, {}).available, false);
});

test('seo: builds grounded phrase groups from category, city, name and rivals', () => {
  const k = buildKeywordStrategy(
    { inferredCategory: 'Italian restaurant', displacement: { competitorName: 'Luigi' }, competitors: [{ domain: 'trattoria-roma.com' }] },
    { name: 'Bella Trattoria', category: 'Italian restaurant', city: 'Leeds' }
  );
  assert.equal(k.available, true);
  assert.equal(k.category, 'Italian restaurant');
  const titles = k.groups.map(g => g.key);
  assert.ok(titles.includes('ready'));
  assert.ok(titles.includes('yourname'));
  assert.ok(titles.includes('comparing'), 'rivals present => comparison group');
  assert.ok(titles.includes('learning'));
  // "ready to buy" phrases include the location.
  const ready = k.groups.find(g => g.key === 'ready');
  assert.ok(ready.phrases.some(p => /Leeds/i.test(p)));
  // name-based group uses the real business name.
  const yourname = k.groups.find(g => g.key === 'yourname');
  assert.ok(yourname.phrases.some(p => /Bella Trattoria/i.test(p)));
});

test('seo: omits the comparison group when no rivals were recorded', () => {
  const k = buildKeywordStrategy({ inferredCategory: 'plumber' }, { name: 'AceFix', city: '' });
  const keys = k.groups.map(g => g.key);
  assert.ok(!keys.includes('comparing'), 'no invented rivals => no comparison group');
});

test('seo: never emits a fake search-volume number', () => {
  const k = buildKeywordStrategy({ inferredCategory: 'law firm' }, { name: 'Hartley', city: 'Manchester' });
  const blob = JSON.stringify(k);
  assert.ok(!/searches?\s*(\/|per)?\s*(month|mo)/i.test(blob), 'no fabricated search volume');
});
