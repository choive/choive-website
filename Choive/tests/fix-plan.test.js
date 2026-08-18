'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildFixPlan } = require('../netlify/functions/lib/fix-plan');

// A realistic paid result with a scoring ledger (scoreMethod.audits) plus
// model actions and signal audit rows.
function sampleResult() {
  return {
    overallScore: 58,
    pillars: {
      clarity: { score: 18, finding: 'Offer is stated but category is vague.' },
      trust: { score: 9, finding: 'Little independent verification found.' },
      difference: { score: 16, finding: 'Some differentiation present.' },
      ease: { score: 15, finding: 'Key facts are hard to find.' }
    },
    scoreMethod: {
      version: 'v3',
      audits: {
        clarity: [
          { ruleId: 'CL1', label: 'Category clearly stated', points: 5, maxPoints: 8, verification: 'mechanical', observed: 'Category implied but not explicit on homepage.' },
          { ruleId: 'CL2', label: 'Location stated', points: 8, maxPoints: 8, verification: 'mechanical', observed: 'City present in footer.' }
        ],
        trust: [
          { ruleId: 'TR1', label: 'Independent reviews', points: 2, maxPoints: 10, verification: 'independent', observed: 'No third-party review profile found.' },
          { ruleId: 'TR2', label: 'Press or citations', points: 3, maxPoints: 7, verification: 'independent', observed: 'No press coverage located.' }
        ],
        difference: [
          { ruleId: 'DF1', label: 'Distinct positioning', points: 6, maxPoints: 9, verification: 'model_assessed', observed: 'Differentiator stated but generic.' }
        ],
        ease: [
          { ruleId: 'EA1', label: 'Contact/booking obvious', points: 4, maxPoints: 9, verification: 'mechanical', observed: 'Booking link buried below the fold.' },
          { ruleId: 'EA2', label: 'Structured data present', points: 0, maxPoints: 0, verification: 'unmeasured', observed: 'Check did not run.' }
        ]
      }
    },
    signalAudit: {
      clarity: [{ name: 'Category clear', status: 'partial', detail: 'implied' }],
      trust: [{ name: 'Reviews', status: 'fail', detail: 'none found' }],
      difference: [],
      ease: [{ name: 'Booking obvious', status: 'fail', detail: 'buried' }]
    },
    actions: [
      { priority: 'critical', title: 'Get independent reviews', body: 'Create a Google Business Profile and gather at least 10 reviews. This gives AI systems independent trust proof.', verification: 'Search your business name and confirm a review profile with 10+ reviews.', if_nothing: 'AI keeps favouring competitors with visible reviews.' },
      { priority: 'high', title: 'State your category explicitly', body: 'Add a one-line category statement to your homepage hero for clarity.', verification: 'Homepage hero names the category in plain words.' }
    ]
  };
}

test('buildFixPlan uses the ledger and computes point impact from maxPoints - points', () => {
  const plan = buildFixPlan(sampleResult());
  assert.strictEqual(plan.available, true);
  // Should NOT include the full-credit rule (CL2) or the unmeasured rule (EA2).
  const ids = plan.fixes.map(f => f.id);
  assert.ok(!ids.includes('CL2'), 'full-credit rule excluded');
  assert.ok(!ids.includes('EA2'), 'unmeasured rule excluded');
  // TR1 gap = 10 - 2 = 8, the biggest single impact.
  const tr1 = plan.fixes.find(f => f.id === 'TR1');
  assert.strictEqual(tr1.pointImpact, 8);
  assert.strictEqual(tr1.closability, 'external-evidence');
});

test('fixes are ranked by point impact, biggest first', () => {
  const plan = buildFixPlan(sampleResult());
  for (let i = 1; i < plan.fixes.length; i++) {
    assert.ok(plan.fixes[i - 1].pointImpact >= plan.fixes[i].pointImpact, 'descending impact');
  }
  assert.strictEqual(plan.fixes[0].rank, 1);
});

test('summary totals are correct and quick wins are self-serve only', () => {
  const plan = buildFixPlan(sampleResult());
  // Ledger gaps: CL1=3, TR1=8, TR2=4, DF1=3, EA1=5 => total 23
  assert.strictEqual(plan.summary.totalRecoverable, 23);
  // Quick wins (clarity+ease): CL1=3, EA1=5 => 8
  assert.strictEqual(plan.summary.quickWinPoints, 8);
  assert.strictEqual(plan.summary.quickWinCount, 2);
  // Trust has the most recoverable points (8+4=12) => top pillar
  assert.strictEqual(plan.summary.topPillar, 'trust');
});

test('relevant model action gets attached with how + verify', () => {
  const plan = buildFixPlan(sampleResult());
  const tr1 = plan.fixes.find(f => f.id === 'TR1');
  assert.ok(tr1.how && tr1.how.length > 0, 'has how-to');
  assert.ok(/review/i.test(tr1.how), 'attached the reviews action');
  assert.ok(tr1.verify && tr1.verify.length > 0, 'has verification step');
});

test('falls back to pillar gap when no audit ledger exists', () => {
  const r = sampleResult();
  delete r.scoreMethod;
  const plan = buildFixPlan(r);
  assert.strictEqual(plan.available, true);
  // One fix per pillar with a gap (all four are < 25)
  assert.strictEqual(plan.fixes.length, 4);
  const trust = plan.fixes.find(f => f.pillar === 'trust');
  assert.strictEqual(trust.pointImpact, 25 - 9);
  assert.strictEqual(trust.basis, 'pillar-gap');
});

test('perfect score yields an empty, unavailable plan', () => {
  const r = { overallScore: 100, pillars: {
    clarity: { score: 25 }, trust: { score: 25 }, difference: { score: 25 }, ease: { score: 25 }
  }, scoreMethod: { audits: {
    clarity: [{ ruleId: 'CL1', label: 'x', points: 8, maxPoints: 8, verification: 'mechanical' }]
  } } };
  const plan = buildFixPlan(r);
  assert.strictEqual(plan.available, false);
  assert.strictEqual(plan.fixes.length, 0);
  assert.strictEqual(plan.headroom, 0);
});

test('handles empty/garbage input without throwing', () => {
  assert.doesNotThrow(() => buildFixPlan(null));
  assert.doesNotThrow(() => buildFixPlan({}));
  assert.doesNotThrow(() => buildFixPlan({ pillars: 'nope', actions: 'nope' }));
  const plan = buildFixPlan({});
  assert.strictEqual(plan.available, false);
});
