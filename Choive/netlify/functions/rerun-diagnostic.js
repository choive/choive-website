// rerun-diagnostic.js
// CHOIVE™ — Re-run diagnostic on same business after fixes implemented
// Creates a new diagnostic linked to the original via parent_job_id
// This produces a REAL score improvement — not simulated
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL

const crypto   = require('crypto');
const supabase = require('./lib/supabase');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function sameHash(a, b) {
  var left = Buffer.from(String(a || ''), 'utf8');
  var right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  var parentJobId = String(body.parentJobId || '').trim();
  var verificationToken = String(body.verificationToken || '').trim().slice(0, 128);
  if (!/^[0-9a-f-]{36}$/i.test(parentJobId) || !verificationToken) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing re-run verification details' })
    };
  }

  // Fetch the original diagnostic to get the input
  var original;
  try {
    original = await supabase.getDiagnostic(parentJobId);
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not fetch original diagnostic' })
    };
  }

  if (!original) {
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Original diagnostic not found' })
    };
  }

  // Only allow paid diagnostics to be re-run
  if (!original.paid) {
    return {
      statusCode: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Only paid diagnostics can be re-run' })
    };
  }

  var input = original.input || {};
  var expectedTokenHash = input._consumerVerificationTokenHash;
  var suppliedTokenHash = crypto.createHash('sha256').update(verificationToken).digest('hex');
  if (!expectedTokenHash || !sameHash(expectedTokenHash, suppliedTokenHash)) {
    return {
      statusCode: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'This browser cannot re-run that diagnostic' })
    };
  }

  var newJobId = crypto.randomUUID();

  // Create new diagnostic linked to parent
  try {
    await supabase.createDiagnosticWithParent(newJobId, input, parentJobId);
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to create re-run diagnostic' })
    };
  }

  // Trigger background engine
  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
  var backgroundUrl = siteUrl + '/.netlify/functions/run-diagnostic-background';

  try {
    var triggerResponse = await fetch(backgroundUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INTERNAL_DIAGNOSTIC_SECRET || process.env.INTERNAL_REPORT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
      },
      body: JSON.stringify({ jobId: newJobId, input: input })
    });
    if (!triggerResponse.ok) {
      throw new Error('Background trigger HTTP ' + triggerResponse.status);
    }
  } catch (err) {
    await supabase.saveError(newJobId, 'Background trigger failed: ' + err.message).catch(() => {});
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not start re-run' })
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newJobId:     newJobId,
      parentJobId:  parentJobId,
      status:       'queued',
      message:      'Re-run started. Poll get-diagnostic for progress.'
    })
  };
};
