// get-by-slug.js
// CHOIVE™ — Resolves a human-readable slug to a diagnostic result page.
// Email links use /results/nike-sportswear (no = sign, safe through Resend).
// This function looks up the slug in Supabase, then 302-redirects to /?jobId=UUID.
// Called via Netlify rewrite: /results/:slug -> /.netlify/functions/get-by-slug?slug=:slug

const { getDiagnosticBySlug } = require('./lib/supabase');

exports.handler = async function(event) {
  var slug = (event.queryStringParameters && event.queryStringParameters.slug) || '';

  // Basic slug safety — only allow letters, digits, hyphens
  if (!slug || !/^[a-z0-9][a-z0-9\-]*$/.test(slug)) {
    return {
      statusCode: 302,
      headers: { Location: 'https://choive.com/' },
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
