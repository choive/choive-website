// get-diagnostic.js
// Polling endpoint — returns current job status and result when complete
// Fast read-only — no computation
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 
const { getDiagnostic } = require('./lib/supabase');
 
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
 
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }
 
  const jobId = event.queryStringParameters?.jobId;
 
  if (!jobId || !jobId.trim()) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing jobId query parameter' })
    };
  }
 
  let job;
  try {
    job = await getDiagnostic(jobId.trim());
  } catch (err) {
    console.error('get-diagnostic: fetch failed:', err.message);
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Diagnostic not found', jobId })
    };
  }
 
  // Processing — return status and current stage only
  if (job.status === 'queued' || job.status === 'collecting_evidence' || job.status === 'scoring') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.job_id,
        status: job.status,
        stage: job.stage || null
      })
    };
  }
 
  // Complete — return full result, including real server-verified paid status
  // (defensive consistency with get-result.js — if this endpoint is ever
  // polled again after payment, e.g. a retry or refresh mid-flow, it should
  // reflect the real Supabase-backed status rather than always reporting
  // unpaid).
  if (job.status === 'complete') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.job_id,
        status: 'complete',
        stage: 'preparing_result',
        result: job.result,
        paid: job.paid === true
      })
    };
  }
 
  // Failed — return error
  if (job.status === 'failed') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.job_id,
        status: 'failed',
        error: job.error?.message || 'Diagnostic failed. Please try again.'
      })
    };
  }
 
  // Unknown status fallback
  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: job.job_id, status: job.status })
  };
};
 
