// badge-token.js
// CHOIVE™ — Mint a signed, tamper-proof badge token for a completed diagnostic.
//
// Given a real jobId, verifies the diagnostic exists and is complete in
// Supabase, then returns an HMAC-signed token plus ready-to-paste embed
// snippets. The token encodes the REAL score at issue time and cannot be
// altered without invalidating the signature — so it can be served from a CDN
// with no per-request database hit while remaining spoof-proof.
//
// GET ?job=<uuid>   or   ?slug=<slug>
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CHOIVE_BADGE_SECRET (optional)

const { getDiagnostic, getDiagnosticBySlug } = require('./lib/supabase');
const { signToken } = require('./lib/badge-verify');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const params = event.queryStringParameters || {};
  let jobId = (params.job || '').trim();
  const slug = (params.slug || '').trim();

  try {
    if (!jobId && slug) {
      const row = await getDiagnosticBySlug(slug);
      if (row && row.job_id) jobId = row.job_id;
    }
    if (!jobId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Provide job or slug' }) };
    }

    const diag = await getDiagnostic(jobId);
    if (!diag) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Diagnostic not found' }) };
    }
    if (diag.status !== 'complete' || !diag.result) {
      return { statusCode: 409, headers: corsHeaders, body: JSON.stringify({ error: 'Diagnostic not complete yet' }) };
    }

    const score = Math.round(Number(diag.result.overallScore));
    if (!(score >= 0 && score <= 100)) {
      return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: 'No valid score on this diagnostic' }) };
    }

    const token = signToken(jobId, score);
    const site = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
    const badgeUrl = site + '/.netlify/functions/badge?token=' + encodeURIComponent(token);
    const liveBadgeUrl = site + '/.netlify/functions/badge?job=' + encodeURIComponent(jobId);
    const name = (diag.input && diag.input.name) || 'your business';

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({
        jobId,
        score,
        verified: true,
        token,
        // Cached, offline-verifiable badge (score fixed at issue time):
        badgeImageUrl: badgeUrl,
        // Always-live badge (re-reads current score from Supabase each render):
        liveBadgeImageUrl: liveBadgeUrl,
        embedImg: `<a href="${site}/result?jobId=${jobId}"><img src="${liveBadgeUrl}" alt="CHOIVE Score for ${escapeAttr(name)}: ${score}"></a>`,
        embedWidget: `<div id="choive-score" data-job="${jobId}" data-style="card"></div>\n<script src="${site}/choive-widget.js" async></script>`
      })
    };
  } catch (err) {
    console.error('badge-token error:', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not mint badge token' }) };
  }
};

function escapeAttr(s) {
  return String(s).replace(/[<>&"']/g, '').slice(0, 80);
}
