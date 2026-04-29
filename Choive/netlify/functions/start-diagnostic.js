// start-diagnostic.js
// CHOIVE™ Stage 1 — Entry point
// Validates input, creates job, triggers background process
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL (e.g. https://choive.com)

const { randomUUID } = require('crypto');
const { createDiagnostic, saveError } = require('./lib/supabase');
const { validateInput } = require('./lib/validators');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

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

  const validation = validateInput(body);
  if (!validation.valid) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: validation.error })
    };
  }

  const input = {
    name:        String(body.name).trim(),
    category:    String(body.category).trim(),
    city:        String(body.city).trim(),
    website:     String(body.website     || '').trim(),
    description: String(body.description || '').trim()
  };

  const jobId = randomUUID();

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

  // Fixed background URL — uses Netlify URL env var, no header parsing
  const siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
  const backgroundUrl = siteUrl + '/.netlify/functions/run-diagnostic-background';
  console.log('CHOIVE background trigger:', backgroundUrl);

  try {
    const triggerRes = await fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, input })
    });

    if (!triggerRes.ok) {
      const errText = await triggerRes.text().catch(() => 'no body');
      console.error('CHOIVE start-diagnostic: Background trigger returned', triggerRes.status, errText);
      await saveError(jobId, 'Background trigger failed with status ' + triggerRes.status + ': ' + errText).catch(() => {});
      return {
        statusCode: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Diagnostic engine could not be started. Please try again.' })
      };
    }
  } catch (err) {
    console.error('CHOIVE start-diagnostic: Background trigger threw:', err.message);
    await saveError(jobId, 'Background trigger network error: ' + err.message).catch(() => {});
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not start diagnostic. Please try again.' })
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, status: 'queued' })
  };
};
