'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildImplementationPlan } = require('../netlify/functions/lib/implementation-plan');

function resultWithActions(titles) {
  return {
    overallScore: 60,
    actions: titles.map(function (t, i) { return { title: t, priority: i + 1 }; })
  };
}

test('impl-plan: unavailable when there are no recorded actions', () => {
  const plan = buildImplementationPlan({ overallScore: 50, actions: [] });
  assert.strictEqual(plan.available, false);
  assert.deepStrictEqual(plan.milestones, []);
  assert.strictEqual(plan.monitoring, null);
});

test('impl-plan: unavailable when result is missing', () => {
  assert.strictEqual(buildImplementationPlan(null).available, false);
  assert.strictEqual(buildImplementationPlan(undefined).available, false);
});

test('impl-plan: builds three 30/60/90 milestones when actions exist', () => {
  const plan = buildImplementationPlan(resultWithActions(['Fix your homepage title', 'Add customer reviews', 'Write an About page', 'Explain what makes you different']));
  assert.strictEqual(plan.available, true);
  assert.strictEqual(plan.milestones.length, 3);
  assert.strictEqual(plan.milestones[0].window, 'Days 1 to 30');
  assert.strictEqual(plan.milestones[1].window, 'Days 31 to 60');
  assert.strictEqual(plan.milestones[2].window, 'Days 61 to 90');
});

test('impl-plan: window 1 always opens with publishing prepared work and takes job 1', () => {
  const plan = buildImplementationPlan(resultWithActions(['Fix your homepage title', 'Add customer reviews']));
  const first = plan.milestones[0];
  assert.ok(/publish/i.test(first.steps[0]), 'window 1 step 1 mentions publishing');
  assert.ok(first.steps.some(function (s) { return s === 'Fix your homepage title'; }), 'window 1 includes the top job verbatim');
});

test('impl-plan: window 3 always ends by rerunning CHOIVE', () => {
  const plan = buildImplementationPlan(resultWithActions(['A', 'B', 'C']));
  const last = plan.milestones[2];
  assert.ok(/run choive again/i.test(last.steps[last.steps.length - 1]), 'window 3 ends with a rerun step');
});

test('impl-plan: never invents jobs — only real titles appear', () => {
  const titles = ['Fix homepage', 'Add reviews', 'Write About', 'Show difference', 'Make contact easy'];
  const plan = buildImplementationPlan(resultWithActions(titles));
  const allSteps = plan.milestones.reduce(function (acc, m) { return acc.concat(m.steps); }, []);
  // Every step is either one of the two fixed steps or one of the real titles.
  allSteps.forEach(function (s) {
    const isFixed = /publish the work choive already prepared/i.test(s) || /run choive again/i.test(s);
    const isReal = titles.indexOf(s) !== -1;
    assert.ok(isFixed || isReal, 'step must be a fixed step or a real recorded job: ' + s);
  });
});

test('impl-plan: single action still produces a valid three-stage plan', () => {
  const plan = buildImplementationPlan(resultWithActions(['Only job']));
  assert.strictEqual(plan.available, true);
  assert.strictEqual(plan.milestones.length, 3);
  // Job appears in window 1; later windows have only their fixed/empty steps.
  assert.ok(plan.milestones[0].steps.indexOf('Only job') !== -1);
});

test('impl-plan: monitoring is included, 90 days, checkpoints at 30/60/90', () => {
  const plan = buildImplementationPlan(resultWithActions(['A']));
  assert.strictEqual(plan.monitoring.included, true);
  assert.strictEqual(plan.monitoring.days, 90);
  assert.deepStrictEqual(plan.monitoring.checkpoints, [30, 60, 90]);
  assert.ok(Array.isArray(plan.monitoring.howItWorks) && plan.monitoring.howItWorks.length >= 3);
});

test('impl-plan: monitoring never promises a higher score', () => {
  const plan = buildImplementationPlan(resultWithActions(['A']));
  const blob = JSON.stringify(plan.monitoring).toLowerCase();
  // Only flag POSITIVE promises. The honest disclaimer ("does not ... promise a
  // higher score") is a negation and must be allowed.
  assert.ok(!/\bwe guarantee\b|guaranteed (higher|better)|will (increase|raise|boost|improve) your score/.test(blob), 'no score-gain promise in monitoring copy');
});

test('impl-plan: each milestone carries a matching day checkpoint', () => {
  const plan = buildImplementationPlan(resultWithActions(['A', 'B']));
  assert.strictEqual(plan.milestones[0].monitor.day, 30);
  assert.strictEqual(plan.milestones[1].monitor.day, 60);
  assert.strictEqual(plan.milestones[2].monitor.day, 90);
});

test('impl-plan: drops blank/whitespace action titles', () => {
  const plan = buildImplementationPlan({
    overallScore: 40,
    actions: [{ title: '   ' }, { title: 'Real job' }, { title: '' }]
  });
  const allSteps = plan.milestones.reduce(function (acc, m) { return acc.concat(m.steps); }, []);
  assert.ok(allSteps.indexOf('Real job') !== -1);
  assert.ok(allSteps.indexOf('   ') === -1);
});
