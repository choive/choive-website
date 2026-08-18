// monitor-run.js
// CHOIVE™ — Scheduled score-monitoring worker.
//
// Runs on a schedule (see netlify.toml). For every subscription that is due, it
// reads the LATEST completed diagnostic score for that business (real data, via
// the same business_fingerprint the engine uses for longitudinal tracking),
// compares it to the last observed score, and emails an alert when the move is
// at least the subscriber's threshold. It then reschedules the next check.
//
// Optionally (MONITOR_TRIGGER_RERUN=true) it also kicks off a fresh background
// re-diagnostic so the next cycle has newly-measured data. That consumes engine
// API credits, so it is OFF by default and gated behind an env flag.
//
// Manual trigger (for testing): POST with header X-Internal-Token: <secret>.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (optional),
//      URL, MONITOR_TRIGGER_RERUN (optional), INTERNAL_DIAGNOSTIC_SECRET (optional)

const store = require('./lib/monitor-store');
const email = require('./lib/monitor-email');
const { getPreviousResult, getDiagnostic } = require('./lib/supabase');

const MAX_PER_RUN = parseInt(process.env.MONITOR_MAX_PER_RUN || '50', 10);

function isAuthorized(event) {
  // Netlify scheduled invocations are internal. Manual HTTP calls must present
  // the internal secret when one is configured.
  const secret = process.env.INTERNAL_DIAGNOSTIC_SECRET || process.env.INTERNAL_REPORT_SECRET;
  if (!secret) return true; // no secret configured → allow (scheduler only)
  const hdr = (event.headers && (event.headers['x-internal-token'] || event.headers['X-Internal-Token'])) || '';
  const scheduled = !!(event.body && String(event.body).includes('next_run'));
  return scheduled || hdr === secret;
}

async function currentScoreFor(sub) {
  // Prefer fingerprint (captures self-run or auto re-runs over time).
  if (sub.business_fingerprint) {
    const prev = await getPreviousResult(sub.business_fingerprint);
    if (prev && prev.result && typeof prev.result.overallScore !== 'undefined') {
      const s = Math.round(Number(prev.result.overallScore));
      if (s >= 0 && s <= 100) return { score: s, jobId: prev.job_id };
    }
  }
  // Fallback: the originally-subscribed diagnostic.
  const diag = await getDiagnostic(sub.job_id);
  if (diag && diag.status === 'complete' && diag.result) {
    const s = Math.round(Number(diag.result.overallScore));
    if (s >= 0 && s <= 100) return { score: s, jobId: sub.job_id };
  }
  return null;
}

async function maybeTriggerRerun(sub) {
  if (process.env.MONITOR_TRIGGER_RERUN !== 'true') return;
  try {
    const diag = await getDiagnostic(sub.job_id);
    if (!diag || !diag.input) return;
    const crypto = require('crypto');
    const supabaseLib = require('./lib/supabase');
    const newJobId = crypto.randomUUID();
    await supabaseLib.createDiagnosticWithParent(newJobId, diag.input, sub.job_id);
    const site = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
    await fetch(site + '/.netlify/functions/run-diagnostic-background', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INTERNAL_DIAGNOSTIC_SECRET || process.env.INTERNAL_REPORT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
      },
      body: JSON.stringify({ jobId: newJobId, input: diag.input })
    });
  } catch (err) {
    console.warn('monitor-run: auto re-run trigger failed (non-critical):', err.message);
  }
}

exports.handler = async (event) => {
  if (!isAuthorized(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const summary = { due: 0, checked: 0, alerted: 0, errors: 0 };
  let due = [];
  try {
    due = await store.getDueSubscriptions(MAX_PER_RUN);
  } catch (err) {
    console.error('monitor-run: getDueSubscriptions failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
  summary.due = due.length;

  for (const sub of due) {
    try {
      const current = await currentScoreFor(sub);
      if (!current) {
        // Nothing measurable yet — just push the next check out.
        await store.recordCheck(sub.id, sub.last_score, sub.frequency);
        continue;
      }
      summary.checked++;

      const previous = (typeof sub.last_score === 'number')
        ? sub.last_score
        : (typeof sub.baseline_score === 'number' ? sub.baseline_score : current.score);
      const delta = current.score - previous;

      if (Math.abs(delta) >= sub.threshold) {
        await email.sendAlert(sub, {
          newScore: current.score,
          previousScore: previous,
          jobId: current.jobId
        });
        summary.alerted++;
      }

      await store.recordCheck(sub.id, current.score, sub.frequency);
      await maybeTriggerRerun(sub);
    } catch (err) {
      summary.errors++;
      console.error('monitor-run: subscription', sub.id, 'failed:', err.message);
    }
  }

  console.log('monitor-run summary:', JSON.stringify(summary));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, ...summary })
  };
};
