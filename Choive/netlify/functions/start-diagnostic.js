// start-diagnostic.js
// CHOIVE Stage 1 — Entry point
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL
 
const crypto = require('crypto');
const supabase = require('./lib/supabase');
const valid = require('./lib/validators');
 
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
 
  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }
 
  var validation = valid.validateInput(body);
  if (!validation.valid) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: validation.error })
    };
  }
 
  var input = {
    name: String(body['name'] || '').trim(),
    category: String(body['category'] || '').trim(),
    city: String(body['city'] || '').trim(),
    website: String(body['website'] || '').trim(),
    description: String(body['description'] || '').trim(),
    knownCompetitors: String(body['knownCompetitors'] || '').trim()
  };
 
  var jobId = crypto.randomUUID();
 
  try {
    await supabase.createDiagnostic(jobId, input);
  } catch (err) {
    console.error('start-diagnostic: Supabase create failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to initialize diagnostic' })
    };
  }
 
  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
  var backgroundUrl = siteUrl + '/.netlify/functions/run-diagnostic-background';
  console.log('CHOIVE background trigger:', backgroundUrl);
 
  try {
    var triggerRes = await fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: jobId, input: input })
    });
    if (!triggerRes.ok) {
      var errText = await triggerRes.text().catch(() => 'no body');
      console.error('start-diagnostic: trigger returned', triggerRes.status, errText);
      await supabase.saveError(jobId, 'Background trigger failed: ' + triggerRes.status).catch(() => {});
      return {
        statusCode: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Diagnostic engine could not be started. Please try again.' })
      };
    }
  } catch (err) {
    console.error('start-diagnostic: trigger threw:', err.message);
    await supabase.saveError(jobId, 'Background trigger error: ' + err.message).catch(() => {});
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not start diagnostic. Please try again.' })
    };
  }
 
  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: jobId, status: 'queued' })
  };
};
