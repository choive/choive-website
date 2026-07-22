// get-by-slug.js
// CHOIVE™ — Resolves a human-readable slug to a diagnostic result page.
// Email links use /results/nike-sportswear (no = sign, safe through Resend).
// This function looks up the slug in Supabase, then 302-redirects to /?jobId=UUID.
// Called via Netlify rewrite: /results/:slug -> /.netlify/functions/get-by-slug?slug=:slug

const { getDiagnosticBySlug } = require('./lib/supabase');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Methods': 'GET, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { Allow: 'GET' }, body: 'Method Not Allowed' };
  }
  var slug = (event.queryStringParameters && event.queryStringParameters.slug) || '';

  // Basic slug safety — only allow letters, digits, hyphens
  if (!slug || !/^[a-z0-9][a-z0-9\-]*$/.test(slug)) {
    return {
      statusCode: 302,
      headers: { Location: 'https://choive.com/' },
      body: ''
    };
  }

  // Payment-email fallback when an older diagnostic has no generated slug.
  // UUIDs are opaque public result identifiers already used by the main page.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug)) {
    return {
      statusCode: 302,
      headers: { Location: 'https://choive.com/?jobId=' + encodeURIComponent(slug) },
      body: ''
    };
  }

  try {
    var diag = await getDiagnosticBySlug(slug);

    if (!diag || !diag.job_id) {
      // Unknown slug — redirect to homepage
      console.log('get-by-slug: slug not found:', slug);
      return {
        statusCode: 302,
        headers: { Location: 'https://choive.com/' },
        body: ''
      };
    }

    // Redirect to the result page with the jobId as a query param.
    // The = sign here is in the browser (not in an email), so it is safe.
    var target = 'https://choive.com/?jobId=' + encodeURIComponent(diag.job_id);
    console.log('get-by-slug: slug', slug, '-> jobId', diag.job_id);
    return {
      statusCode: 302,
      headers: { Location: target },
      body: ''
    };

  } catch (err) {
    console.error('get-by-slug: error:', err.message);
    return {
      statusCode: 302,
      headers: { Location: 'https://choive.com/' },
      body: ''
    };
  }
};
