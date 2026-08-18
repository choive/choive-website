// get-score-history.js
// Returns the score history for one business over time, so the paid report can
// draw a simple "is my score going up?" graph.
// It reuses the longitudinal data already stored: every re-run of the same
// business shares one business_fingerprint, so we just gather all completed
// runs for that fingerprint and return their scores in order.
//
// This is a PAID feature: history is only returned when the diagnostic that
// asks for it is itself paid. We never invent points — we return only the real
// completed runs that exist in the database.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { getDiagnostic, getDiagnosticHistory, buildFingerprint } = require('./lib/supabase');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  const params = event.queryStringParameters || {};
  const jobId = (params.jobId || '').trim();
  if (!jobId) {
    return jsonResponse(400, { error: 'Missing jobId parameter' });
  }

  try {
    const diag = await getDiagnostic(jobId);
    if (!diag) {
      return jsonResponse(404, { error: 'Diagnostic not found' });
    }

    // Score history is part of the paid report only.
    if (!diag.paid) {
      return jsonResponse(200, { available: false, reason: 'not_paid' });
    }

    // Prefer the fingerprint stored on the row; fall back to rebuilding it.
    const fingerprint = diag.business_fingerprint || buildFingerprint(diag.input || {});
    if (!fingerprint) {
      return jsonResponse(200, { available: false, reason: 'no_fingerprint' });
    }

    const history = await getDiagnosticHistory(fingerprint);

    // Keep only rows that actually have a real numeric score.
    const points = (history || [])
      .map(function (row) {
        const r = row.result || {};
        const score = Number(r.overallScore);
        if (!isFinite(score) || score < 0 || score > 100) return null;
        return {
          version: row.version || 1,
          score: Math.round(score),
          date: row.created_at || null,
          paid: !!row.paid,
          jobId: row.job_id,
          current: row.job_id === jobId
        };
      })
      .filter(Boolean)
      .sort(function (a, b) { return (a.version || 0) - (b.version || 0); });

    if (points.length === 0) {
      return jsonResponse(200, { available: false, reason: 'no_scores' });
    }

    return jsonResponse(200, {
      available: true,
      count: points.length,
      points
    });
  } catch (err) {
    console.error('get-score-history error:', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
};
