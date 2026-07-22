// self-diagnostic.js
// CHOIVE™ — Runs CHOIVE's own diagnostic on choive.com
// Scheduled to run once per month via Netlify scheduled functions
// Stores result in Supabase 'self_diagnostic' table
// Displayed on choive.com homepage as live proof the product works on itself
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { realtime: { transport: ws } }
  );
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // GET — return the latest self-diagnostic result for display on homepage
  if (event.httpMethod === 'GET') {
    try {
      var readClient = getSupabase();
      var { data, error } = await readClient
        .from('self_diagnostic')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data) {
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: null })
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: data })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.message })
      };
    }
  }

  // POST — run a new self-diagnostic (called by scheduler or manually)
  var selfSecret = process.env.SELF_DIAGNOSTIC_SECRET || process.env.INTERNAL_AI_SECRET;
  if (!selfSecret || event.headers['x-internal-token'] !== selfSecret) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }
  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');

  // Trigger a real diagnostic on CHOIVE itself
  var crypto = require('crypto');
  var jobId  = crypto.randomUUID();

  var input = {
    name:        'CHOIVE',
    category:    'AI selection diagnostic',
    city:        'Global',
    website:     'https://choive.com',
    description: 'A diagnostic that identifies why AI is not recommending your business and delivers an instant verdict on exactly what to fix'
  };

  try {
    // Create the diagnostic record
    var writeClient = getSupabase();
    var insertResult = await writeClient.from('diagnostics').insert({
      job_id:               jobId,
      status:               'queued',
      stage:                null,
      input:                input,
      evidence:             null,
      result:               null,
      error:                null,
      business_fingerprint: 'choive-self',
      parent_job_id:        null,
      version:              1
    });
    if (insertResult.error) {
      throw new Error('Self-diagnostic insert failed: ' + insertResult.error.message);
    }

    // Fire the background engine and return immediately — do NOT poll here.
    // Regular Netlify functions timeout at 10s; the background engine takes
    // 60-120s. The background function writes the result to self_diagnostic
    // when it finishes; the GET handler above reads from there.
    var bgUrl = siteUrl + '/.netlify/functions/run-diagnostic-background';
    var triggerResponse = await fetch(bgUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INTERNAL_DIAGNOSTIC_SECRET || process.env.INTERNAL_REPORT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
      },
      body: JSON.stringify({ jobId, input })
    });
    if (!triggerResponse.ok) {
      throw new Error('Background trigger HTTP ' + triggerResponse.status);
    }

    console.log('[self-diagnostic] Queued jobId:', jobId);

    return {
      statusCode: 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, jobId, status: 'queued' })
    };
    // The background function (run-diagnostic-background.js) writes the result
    // to the self_diagnostic table automatically when it finishes (it detects
    // choive.com and saves there). The GET handler above reads from that table.

  } catch (err) {
    console.error('[self-diagnostic] Error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
