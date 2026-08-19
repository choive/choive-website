// implementation-plan.js
// CHOIVE™ — 30/60/90-day implementation plan + included 90-day monitoring schedule.
//
// This turns the real, recorded fix actions into three clear 30-day milestones,
// and lays a matching monitoring checkpoint on each one. It is built ONLY from
// evidence that already exists on the result:
//   - result.actions (the prioritised jobs the diagnostic produced)
// It NEVER invents jobs, NEVER promises a score gain, and NEVER adds a number
// that was not measured. If there are no recorded actions, the plan reports
// available:false and the report simply does not show a milestone plan.
//
// The monitoring schedule describes a benefit that already exists (free score
// watching, see monitor-subscribe.js). It is framed honestly: three automatic
// re-checks over the first 90 days, included with the Complete Report. It does
// not claim monitoring is exclusive or paid.

'use strict';

// Plain-language milestone frames. These are fixed labels/goals — NOT claims
// about the business. They describe the ORDER of work, in words a five-year-old
// can follow.
const MILESTONE_FRAMES = [
  {
    id: 'days-1-30',
    window: 'Days 1 to 30',
    heading: 'Publish and start',
    goal: 'Put the ready-made work live and begin the most important job.',
    monitor: {
      day: 30,
      label: 'Day 30 check',
      note: 'CHOIVE re-checks your score at day 30 and emails you what changed.'
    }
  },
  {
    id: 'days-31-60',
    window: 'Days 31 to 60',
    heading: 'Keep fixing',
    goal: 'Finish the next jobs, one at a time.',
    monitor: {
      day: 60,
      label: 'Day 60 check',
      note: 'CHOIVE re-checks your score at day 60 and emails you what changed.'
    }
  },
  {
    id: 'days-61-90',
    window: 'Days 61 to 90',
    heading: 'Check your work',
    goal: 'Finish the last jobs and run CHOIVE again to see what moved.',
    monitor: {
      day: 90,
      label: 'Day 90 check',
      note: 'CHOIVE re-checks your score at day 90 so you can place the old and new scores side by side.'
    }
  }
];

// Keep a job title short and plain. We do not rewrite the meaning — we only
// trim to the title the diagnostic already wrote.
function jobTitle(action) {
  if (!action) return '';
  const t = String(action.title || '').trim();
  return t;
}

// Split the real recorded actions across the three windows.
//   Window 1 (Days 1-30): "publish assets" + first job
//   Window 2 (Days 31-60): next jobs
//   Window 3 (Days 61-90): remaining jobs + rerun
// The split adapts to how many jobs actually exist. We never pad with invented
// jobs; a window can legitimately have only its fixed step.
function distributeJobs(titles) {
  const buckets = [[], [], []];
  const n = titles.length;
  if (n === 0) return buckets;
  // First window always takes job 1 (the highest priority fix).
  buckets[0].push(titles[0]);
  if (n === 1) return buckets;
  // Remaining jobs split as evenly as possible across windows 2 and 3,
  // with window 2 taking the earlier (higher-priority) half.
  const rest = titles.slice(1);
  const half = Math.ceil(rest.length / 2);
  buckets[1] = rest.slice(0, half);
  buckets[2] = rest.slice(half);
  return buckets;
}

function buildImplementationPlan(result) {
  const unavailable = { available: false, milestones: [], monitoring: null };
  if (!result || typeof result !== 'object') return unavailable;

  const actions = Array.isArray(result.actions) ? result.actions : [];
  const titles = actions
    .map(jobTitle)
    .filter(function (t) { return t; });

  // With no recorded jobs there is nothing honest to schedule.
  if (titles.length === 0) return unavailable;

  const buckets = distributeJobs(titles);

  const milestones = MILESTONE_FRAMES.map(function (frame, i) {
    const steps = [];
    // Fixed opening step for window 1 only: publish the prepared work.
    if (i === 0) {
      steps.push('Publish the work CHOIVE already prepared (only the items that are correct for your business).');
    }
    // Real jobs for this window.
    buckets[i].forEach(function (t) { steps.push(t); });
    // Fixed closing step for window 3 only: rerun.
    if (i === 2) {
      steps.push('Run CHOIVE again with the same name, website, and location.');
    }
    return {
      id: frame.id,
      window: frame.window,
      heading: frame.heading,
      goal: frame.goal,
      steps: steps,
      jobCount: buckets[i].length,
      monitor: frame.monitor
    };
  });

  const monitoring = {
    included: true,
    days: 90,
    checkpoints: [30, 60, 90],
    // Honest framing: this benefit already exists and is free; we present it as
    // included and pre-scheduled with the Complete Report. No exclusivity claim.
    summary: 'Your Complete Report includes 90 days of automatic score watching. CHOIVE re-checks your score at day 30, day 60, and day 90, and emails you what changed. You turn it on once — CHOIVE does the rest.',
    howItWorks: [
      'You turn on watching one time using the button below.',
      'CHOIVE checks your score again at day 30, day 60, and day 90.',
      'You get an email each time that shows what went up, down, or stayed the same.',
      'It costs nothing extra. It is part of your Complete Report.'
    ],
    note: 'Watching only re-runs the same checks CHOIVE already did. It does not change your work or promise a higher score.'
  };

  return {
    available: true,
    milestones: milestones,
    monitoring: monitoring
  };
}

module.exports = { buildImplementationPlan, MILESTONE_FRAMES };
