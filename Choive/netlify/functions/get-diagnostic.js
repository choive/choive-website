// get-diagnostic.js
// CHOIVE™ polling endpoint
// Returns current diagnostic status and final result when complete
// Fast read-only — no computation
//
// ENV:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

const { getDiagnostic } = require('./lib/supabase');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: 'Method Not Allowed'
    };
  }

  const jobId = safeString(event.queryStringParameters?.jobId);

  if (!jobId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Missing jobId query parameter'
      })
    };
  }

  let job;
  try {
    job = await getDiagnostic(jobId);
  } catch (err) {
    console.error('CHOIVE get-diagnostic: fetch failed:', err.message);

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to fetch diagnostic',
        jobId
      })
    };
  }

  if (!job) {
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Diagnostic not found',
        jobId
      })
    };
  }

  if (['queued', 'collecting_evidence', 'scoring'].includes(job.status)) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.job_id,
        status: job.status,
        stage: job.stage || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      })
    };
  }

  if (job.status === 'complete') {
  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: job.job_id,
      status: 'complete',
      stage: null,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      paid: job.paid === true,
      result: job.result
    })
  };
}

  if (job.status === 'failed') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.job_id,
        status: 'failed',
        stage: null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        error: job.error?.message || 'Diagnostic failed. Please try again.'
      })
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: job.job_id,
      status: job.status || 'unknown',
      stage: job.stage || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    })
  };
};
