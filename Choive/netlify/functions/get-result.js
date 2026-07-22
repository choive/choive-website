// get-result.js
// CHOIVE™ — Public shareable result page
// Returns full diagnostic result for a given jobId
// Used by the shareable URL: /result?jobId=...
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { getDiagnostic } = require('./lib/supabase');
const { buildPublicResult } = require('./lib/public-result');

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
        result: diagnostic.paid === true
          ? diagnostic.result
          : buildPublicResult(diagnostic.result),
        // Real, server-verified payment status — read directly from Supabase,
        // not trusted from anything client-side. Without this, reopening a
        // shared link (?jobId=...) after payment would re-show the paywall,
        // since the frontend's fallback check (data.result.paid) is never
        // actually present in the saved result JSON.
        paid: diagnostic.paid === true,
        input: {
          name: diagnostic.input?.name || '',
          category: diagnostic.input?.category || '',
          city: diagnostic.input?.city || '',
          website: diagnostic.input?.website || '',
          subjectType: diagnostic.input?.subjectType || 'business'
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
