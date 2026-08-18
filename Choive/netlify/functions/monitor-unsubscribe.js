// monitor-unsubscribe.js
// CHOIVE™ — One-click stop for score monitoring (from any alert email).
// GET ?token=<unsubscribe_token>  → deactivates the subscription.
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
    return { statusCode: 400, headers, body: page('Invalid link', '<h1>Invalid link</h1><p>This link is missing its token.</p><a href="/">Back to CHOIVE</a>') };
  }
  try {
    const row = await store.deactivateByToken(t);
    if (!row) {
      return { statusCode: 404, headers, body: page('Not found', '<h1>Nothing to stop</h1><p>This link is invalid or monitoring was already stopped.</p><a href="/">Back to CHOIVE</a>') };
    }
    return {
      statusCode: 200, headers,
      body: page('Monitoring stopped', '<h1>Monitoring stopped.</h1><p>You won\u2019t receive any more score alerts for this business. You can re-enable monitoring anytime from your result page.</p><a href="/monitor">Monitoring settings</a>')
    };
  } catch (err) {
    console.error('monitor-unsubscribe error:', err.message);
    return { statusCode: 500, headers, body: page('Something went wrong', '<h1>Something went wrong</h1><p>Please try again, or contact hello@choive.com.</p><a href="/">Back to CHOIVE</a>') };
  }
};
