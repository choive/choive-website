// start-diagnostic.js
// CHOIVE™ Stage 1 — Entry point
// Validates input, creates job, triggers background process, awaits trigger confirmation
// ENV:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

const { randomUUID } = require('crypto');
const { createDiagnostic, markDiagnosticFailed } = require('./lib/supabase');
const { validateInput } = require('./lib/validators');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Method check
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: 'Method Not Allowed'
    };
  }

  // Parse body safely
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  // Validate input
  const validation = validateInput(body);
  if (!validation.valid) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: validation.error })
    };
  }

  // Normalize input
  const input = {
    name: String(body.name).trim(),
    category: String(body.category).trim(),
    city: String(body.city).trim(),
    website: String(body.website || '').trim(),
    description: String(body.description || '').trim()
  };

  // Generate unique job ID
  const jobId = randomUUID();

  // Create diagnostic record
  try {
    await createDiagnostic(jobId, input);
  } catch (err) {
    console.error('CHOIVE start-diagnostic: Supabase create failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to initialize diagnostic' })
    };
  }

  // Resolve background function URL safely
  const proto =
    event.headers['x-forwarded-proto'] ||
    event.headers['X-Forwarded-Proto'] ||
    'https';

  const host =
    event.headers.host ||
    event.headers['x-forwarded-host'] ||
    event.headers['X-Forwarded-Host'];

  if (!host) {
    console.error('CHOIVE start-diagnostic: Missing host header');
    await markDiagnosticFailed(jobId, {
      message: 'Missing host header for background trigger'
    }).catch(() => {});
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal routing failure' })
    };
  }

  const backgroundUrl = `${proto}://${host}/.netlify/functions/run-diagnostic-background`;

  // Await background trigger — do not fire and forget
  try {
    const triggerRes = await fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, input })
    });

    if (!triggerRes.ok) {
      const errText = await triggerRes.text().catch(() => 'no body');
      console.error(
        `CHOIVE start-diagnostic: Background trigger returned ${triggerRes.status}: ${errText}`
      );
      await markDiagnosticFailed(jobId, {
        message: `Background trigger failed with status ${triggerRes.status}`,
        detail: errText
      }).catch(() => {});
      return {
        statusCode: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Diagnostic engine could not be started. Please try again.' })
      };
    }
  } catch (err) {
    console.error('CHOIVE start-diagnostic: Background trigger threw:', err.message);
    await markDiagnosticFailed(jobId, {
      message: 'Background trigger network error',
      detail: err.message
    }).catch(() => {});
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not start diagnostic. Please try again.' })
    };
  }

  // Background confirmed — return jobId to frontend
  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, status: 'queued' })
  };
};
