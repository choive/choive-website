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

    var target = 'https://choive.com/?jobId=' + encodeURIComponent(diag.job_id);
    console.log('get-by-slug: slug', slug, '-> jobId', diag.job_id);
    
    // Return an SEO-friendly preview page with meta tags for social sharing
    var result = diag.result || {};
    var input = diag.input || {};
    var businessName = input.name || 'Business';
    var score = Math.round(Number(result.overallScore) || 0);
    var category = result.inferredCategory || input.category || 'business';
    var pageTitle = businessName + ' — CHOIVE Score: ' + score + '/100';
    var description = businessName + ' scored ' + score + '/100 on the CHOIVE Index™. See how AI recommends this ' + category + '.';
    var ogImage = 'https://choive.com/og-image.png'; // Default OG image
    
    var html = '<!DOCTYPE html><html lang="en"><head>'
      + '<meta charset="UTF-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      + '<title>' + esc(pageTitle) + '</title>'
      + '<meta name="description" content="' + esc(description) + '">'
      + '<meta property="og:title" content="' + esc(pageTitle) + '">'
      + '<meta property="og:description" content="' + esc(description) + '">'
      + '<meta property="og:image" content="' + ogImage + '">'
      + '<meta property="og:url" content="https://choive.com/results/' + encodeURIComponent(slug) + '">'
      + '<meta property="og:type" content="website">'
      + '<meta name="twitter:card" content="summary_large_image">'
      + '<meta name="twitter:title" content="' + esc(pageTitle) + '">'
      + '<meta name="twitter:description" content="' + esc(description) + '">'
      + '<meta name="twitter:image" content="' + ogImage + '">'
      + '<link rel="canonical" href="' + target + '">'
      + '<meta http-equiv="refresh" content="0;url=' + target + '">'
      + '<style>body{font-family:Inter,sans-serif;background:#0C0C0E;color:#F5F2EE;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center;}a{color:#C9A86A;text-decoration:none;border-bottom:1px solid #C9A86A;}</style>'
      + '</head><body>'
      + '<div><h1 style="font-size:32px;margin:0 0 12px;">' + esc(businessName) + '</h1>'
      + '<p style="font-size:18px;color:rgba(245,242,238,0.7);">CHOIVE Score: <strong style="color:#C9A86A;">' + score + '/100</strong></p>'
      + '<p style="font-size:14px;margin:20px 0;"><a href="' + target + '">View full CHOIVE result →</a></p></div>'
      + '</body></html>';
    
    function esc(str) {
      return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html
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
