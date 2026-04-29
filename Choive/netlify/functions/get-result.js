// get-result.js
// CHOIVE™ — Public shareable result page
// Returns full diagnostic result for a given jobId
// Used by the shareable URL: /result?jobId=...
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

  const jobId = event.queryStringParameters?.jobId;

  if (!jobId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing jobId' })
    };
  }

  try {
    const diagnostic = await getDiagnostic(jobId);
if (!diagnostic) {
  return {
    statusCode: 404,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Diagnostic not found' })
  };
}

if (diagnostic.status === 'complete' && diagnostic.paid !== true) {
  return {
    statusCode: 403,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: 'Payment required to access full result',
      status: 'locked'
    })
  };
}

if (diagnostic.status !== 'complete') {

    if (diagnostic.status !== 'complete') {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: diagnostic.status,
          error: diagnostic.error || null
        })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'complete',
        result: diagnostic.result,
        input: {
          name:     diagnostic.input?.name     || '',
          category: diagnostic.input?.category || '',
          city:     diagnostic.input?.city     || '',
          website:  diagnostic.input?.website  || ''
        },
        createdAt: diagnostic.created_at
      })
    };
  } catch (err) {
    console.error('CHOIVE get-result error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not retrieve result' })
    };
  }
};
