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

test('difference website checks are self-serve and get concrete "what makes us different" guidance', () => {
  const plan = buildFixPlan({
    overallScore: 40,
    pillars: { clarity: { score: 20 }, trust: { score: 5 }, difference: { score: 10 }, ease: { score: 20 } },
    scoreMethod: { audits: {
      difference: [
        { ruleId: 'DI-01', label: 'Specific differentiator stated', points: 0, maxPoints: 7, verification: 'model_assessed', observed: 'No supported evidence returned' },
        { ruleId: 'DI-02', label: 'Named client or partner', points: 0, maxPoints: 6, verification: 'model_assessed', observed: 'No supported evidence returned' },
        { ruleId: 'DI-03', label: 'Defined niche or category position', points: 0, maxPoints: 6, verification: 'model_assessed', observed: 'No supported evidence returned' }
      ]
    } },
    actions: []
  });
  const di01 = plan.fixes.find(f => f.id === 'DI-01');
  const di02 = plan.fixes.find(f => f.id === 'DI-02');
  const di03 = plan.fixes.find(f => f.id === 'DI-03');
  // Stating your own differentiator / niche is a change you make on your site.
  assert.strictEqual(di01.closability, 'self-serve');
  assert.strictEqual(di03.closability, 'self-serve');
  // Naming a real client still needs outside confirmation.
  assert.strictEqual(di02.closability, 'external-evidence');
  // Concrete, plain fallback guidance points at a dedicated page.
  assert.ok(/what makes us different/i.test(di01.how), 'DI-01 names the page');
  assert.ok(/what makes us different/i.test(di03.how), 'DI-03 names the page');
});

test('the same model action is never attached to two different cards', () => {
  // Regression for the reported bug: a Difference card (#7 "Defined niche") and
  // a Trust card (#8 "Checked review volume") both printed the IDENTICAL review
  // action as their "What to do". A review-heavy action mentions both "category
  // rivals" (difference-ish) and "reviews" (trust), so it matched both cards.
  const result = {
    overallScore: 63,
    pillars: { clarity: { score: 18 }, trust: { score: 3 }, difference: { score: 10 }, ease: { score: 24 } },
    scoreMethod: {
      audits: {
        trust: [
          { ruleId: 'TR-01', label: 'Checked review volume', maxPoints: 15, points: 3, verification: 'external', observed: '3 checked reviews' }
        ],
        difference: [
          { ruleId: 'DI-03', label: 'Defined niche or category position', maxPoints: 6, points: 3, verification: 'website', observed: 'Farm-direct grass-fed Angus implied, not explicitly claimed' }
        ]
      }
    },
    actions: [
      {
        title: 'Get more Google reviews', priority: 'high',
        body: "Business has exactly 3 Google reviews at 5 stars while category rivals cited by AI have substantially more public review proof. Send a post-purchase email with a direct link to your Google review page.",
        verification: 'Confirm 20 or more reviews are publicly visible.'
      }
    ]
  };
  const plan = buildFixPlan(result);
  const diff = plan.fixes.find(f => f.pillar === 'difference');
  const trust = plan.fixes.find(f => f.pillar === 'trust');
  assert.ok(diff && trust, 'both cards present');
  // The two cards must not share the exact same how-to text.
  assert.notStrictEqual(diff.how, trust.how, 'difference and trust cards must differ');
  // The review action belongs to Trust (processed first), not Difference.
  assert.ok(/review/i.test(trust.how), 'trust card keeps the review action');
  // The Difference card falls back to real differentiation guidance.
  assert.ok(/niche|differ|pick you|choose|makes us different/i.test(diff.how),
    'difference card gives differentiation guidance, not review advice');
  assert.ok(!/post-purchase email/i.test(diff.how), 'difference card is not the review action');
});

test('handles empty/garbage input without throwing', () => {
  assert.doesNotThrow(() => buildFixPlan(null));
  assert.doesNotThrow(() => buildFixPlan({}));
  assert.doesNotThrow(() => buildFixPlan({ pillars: 'nope', actions: 'nope' }));
  const plan = buildFixPlan({});
  assert.strictEqual(plan.available, false);
});
