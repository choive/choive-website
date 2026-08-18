// monitor-confirm.js
// CHOIVE™ — Double opt-in confirmation for score monitoring.
// GET ?token=<confirm_token>  → activates the subscription, returns an HTML page.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const store = require('./lib/monitor-store');

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — CHOIVE</title>
<style>
  body{font-family:Inter,Helvetica,Arial,sans-serif;background:#0C0C0E;color:#F5F2EE;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
  .card{max-width:480px;text-align:center;}
  .logo{font-weight:700;letter-spacing:.08em;font-size:18px;margin-bottom:28px;}
  .logo span{color:#C9A86A;}
  h1{font-family:Georgia,serif;font-weight:400;font-style:italic;font-size:26px;line-height:1.3;margin:0 0 14px;}
  p{color:#BBBBC2;line-height:1.7;font-size:15px;}
  a{display:inline-block;margin-top:24px;color:#0C0C0E;background:#C9A86A;text-decoration:none;font-weight:700;letter-spacing:.06em;padding:13px 26px;font-size:14px;}
</style></head><body><div class="card">
<div class="logo">CHOIVE<span>·</span></div>${body}
</div></body></html>`;
}

exports.handler = async (event) => {
  const t = (event.queryStringParameters && event.queryStringParameters.token || '').trim();
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };

  if (!t) {
    return { statusCode: 400, headers, body: page('Invalid link', '<h1>Invalid link</h1><p>This confirmation link is missing its token.</p><a href="/">Back to CHOIVE</a>') };
  }
  try {
    const row = await store.confirmByToken(t);
    if (!row) {
      return { statusCode: 404, headers, body: page('Link expired', '<h1>Link not found</h1><p>This confirmation link is invalid or has already been used.</p><a href="/">Back to CHOIVE</a>') };
    }
    const name = row.business_name || 'your business';
    return {
      statusCode: 200, headers,
      body: page('Monitoring active', `<h1>Monitoring is active.</h1><p>We\u2019ll keep watching the AI selection score for <strong>${escapeHtml(name)}</strong> and email you when it moves. You can stop anytime from any alert email.</p><a href="/monitor">Monitoring settings</a>`)
    };
  } catch (err) {
    console.error('monitor-confirm error:', err.message);
    return { statusCode: 500, headers, body: page('Something went wrong', '<h1>Something went wrong</h1><p>Please try the link again, or contact hello@choive.com.</p><a href="/">Back to CHOIVE</a>') };
  }
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
