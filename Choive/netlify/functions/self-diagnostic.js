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
      var supabase = getSupabase();
      var { data, error } = await supabase
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
  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');

  // Trigger a real diagnostic on CHOIVE itself
  var crypto = require('crypto');
  var jobId  = crypto.randomUUID();

  var input = {
    name:        'CHOIVE',
    category:    'AI selection diagnostic',
    city:        'Global',
    website:     'https://choive.com',
    description: 'The world\'s first AI selection diagnostic for businesses'
  };

  try {
    // Create the diagnostic record
    var supabase = getSupabase();
    await supabase.from('diagnostics').insert({
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

    // Trigger the background engine
    var bgUrl = siteUrl + '/.netlify/functions/run-diagnostic-background';
    await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, input })
    });

    console.log('[self-diagnostic] Started jobId:', jobId);

    // Poll for result (max 90 seconds)
    var attempts = 0;
    var result   = null;
    while (attempts < 18) {
      await new Promise(function(r) { setTimeout(r, 5000); });
      attempts++;

      var { data: diag } = await supabase
        .from('diagnostics')
        .select('status, result')
        .eq('job_id', jobId)
        .maybeSingle();

      if (diag && diag.status === 'complete' && diag.result) {
        result = diag.result;
        break;
      }
      if (diag && diag.status === 'failed') {
        throw new Error('Self-diagnostic failed');
      }
    }

    if (!result) throw new Error('Self-diagnostic timed out');

    // Store in self_diagnostic table for homepage display
    await supabase.from('self_diagnostic').insert({
      job_id:       jobId,
      overall_score: result.overallScore || 0,
      pillars:       result.pillars || {},
      verdict:       result.verdictHeadline || '',
      summary:       result.summaryParagraph || '',
      actions:       result.actions || [],
      created_at:    new Date().toISOString()
    });

    console.log('[self-diagnostic] Complete. Score:', result.overallScore);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, jobId, score: result.overallScore })
    };

  } catch (err) {
    console.error('[self-diagnostic] Error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
