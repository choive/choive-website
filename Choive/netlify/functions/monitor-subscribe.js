// monitor-subscribe.js
// CHOIVE™ — Subscribe to automated CHOIVE Score monitoring.
//
// Unlike the Phase-2 stub (which only logged), this stores a real subscription
// in Supabase, tied to an actual completed diagnostic, and sends a double
// opt-in confirmation email. A scheduled job (monitor-run.js) then re-checks
// the score and alerts on meaningful movement.
//
// POST { jobId, email, frequency: 'weekly'|'monthly', threshold: 5|10|15 }
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (optional), URL

const { getDiagnostic } = require('./lib/supabase');
const store = require('./lib/monitor-store');
const email = require('./lib/monitor-email');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function bad(status, msg) {
  return { statusCode: status, headers: corsHeaders, body: JSON.stringify({ ok: false, error: msg }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return bad(405, 'Method not allowed');

  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch (_) { return bad(400, 'Invalid JSON'); }

  const jobId = String(data.jobId || '').trim();
  const addr = String(data.email || '').trim().toLowerCase();
  const frequency = ['weekly', 'monthly'].includes(data.frequency) ? data.frequency : null;
  const threshold = parseInt(data.threshold, 10);

  if (!jobId) return bad(400, 'Missing diagnostic id (jobId). Run a diagnostic first, then monitor it.');
  if (!addr || !addr.includes('@') || !addr.includes('.')) return bad(400, 'Enter a valid email address.');
  if (!frequency) return bad(400, 'Choose a frequency: weekly or monthly.');
  if (!(threshold >= 1 && threshold <= 50)) return bad(400, 'Threshold must be between 1 and 50 points.');

  // Resolve the diagnostic — this is what makes the subscription real. We only
  // monitor a genuine completed diagnostic, and capture its baseline score.
  let diag;
  try { diag = await getDiagnostic(jobId); }
  catch (err) {
    console.error('monitor-subscribe: getDiagnostic failed:', err.message);
    return bad(500, 'Could not verify that diagnostic. Please try again.');
  }
  if (!diag) return bad(404, 'That diagnostic could not be found. Check the link/ID from your result.');
  if (diag.status !== 'complete' || !diag.result) return bad(409, 'That diagnostic has not finished yet. Try again once your result is ready.');

  const baselineScore = Math.round(Number(diag.result.overallScore));
  const businessName = (diag.input && diag.input.name) || '';
  const fingerprint = diag.business_fingerprint || null;

  let sub;
  try {
    sub = await store.createSubscription({
      email: addr, jobId, fingerprint, businessName,
      frequency, threshold,
      baselineScore: (baselineScore >= 0 && baselineScore <= 100) ? baselineScore : null
    });
  } catch (err) {
    console.error('monitor-subscribe: createSubscription failed:', err.message);
    return bad(500, 'Could not create your subscription. Please try again.');
  }

  // Double opt-in. If somehow already confirmed (re-subscribe), skip the email.
  let confirmationSent = false;
  if (!sub.alreadyConfirmed) {
    const r = await email.sendConfirmation({
      email: addr, confirmToken: sub.confirmToken,
      businessName, frequency, threshold
    });
    confirmationSent = !!(r && r.sent);
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      ok: true,
      status: sub.alreadyConfirmed ? 'already_active' : 'pending_confirmation',
      confirmationSent,
      message: sub.alreadyConfirmed
        ? 'Monitoring is already active for this business.'
        : (confirmationSent
            ? 'Check your inbox to confirm and start monitoring.'
            : 'Subscription saved. Confirmation email could not be sent — contact hello@choive.com if you don\'t receive it.'),
      subscription: {
        business: businessName,
        baselineScore,
        frequency,
        threshold,
        nextCheck: store.nextCheckDate(frequency)
      }
    })
  };
};
