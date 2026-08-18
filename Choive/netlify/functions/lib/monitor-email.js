// lib/monitor-email.js
// CHOIVE™ — Transactional emails for score monitoring (via Resend).
// Matches the brand styling used in save-lead.js. All sends are best-effort;
// callers treat a failure as non-fatal. ENV: RESEND_API_KEY (optional).

function site() {
  return (process.env.URL || 'https://choive.com').replace(/\/$/, '');
}

async function send(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('monitor-email: RESEND_API_KEY not set — skipping send to', to);
    return { sent: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: 'CHOIVE <hello@choive.com>', to: [to], subject, html })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn('monitor-email: send failed', res.status, t);
      return { sent: false, reason: 'http_' + res.status };
    }
    return { sent: true };
  } catch (err) {
    console.warn('monitor-email: send threw', err.message);
    return { sent: false, reason: err.message };
  }
}

function shell(inner) {
  return [
    '<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#0C0C0E;">',
    '<div style="font-size:18px;font-weight:700;letter-spacing:0.08em;margin-bottom:32px;">CHOIVE<span style="color:#C9A86A;">·</span></div>',
    inner,
    '<div style="margin-top:32px;padding-top:24px;border-top:1px solid #F5F2EE;font-size:11px;color:#BBBBC2;">CHOIVE· — Be the answer. Not the alternative.</div>',
    '</div>'
  ].join('');
}

function button(href, text) {
  return '<a href="' + href + '" style="display:inline-block;background:#C9A86A;color:#0C0C0E;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:0.06em;padding:14px 28px;">' + text + '</a>';
}

// Double opt-in confirmation.
async function sendConfirmation(sub) {
  const url = site() + '/.netlify/functions/monitor-confirm?token=' + encodeURIComponent(sub.confirmToken);
  const name = sub.businessName || 'your business';
  const inner = [
    '<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;font-style:italic;margin:0 0 16px;line-height:1.3;">One more tap to start.</h1>',
    '<p style="font-size:14px;line-height:1.8;color:#6E6E76;margin:0 0 24px;">You asked CHOIVE to keep an eye on the score for <strong>' + esc(name) + '</strong> and email you when it moves by ' + sub.threshold + ' points or more (we check ' + esc(sub.frequency) + '). Tap below to start:</p>',
    button(url, 'Yes, start watching →'),
    '<p style="font-size:12px;color:#BBBBC2;margin-top:40px;line-height:1.7;">If this wasn\'t you, just ignore this email — nothing will start.</p>'
  ].join('');
  return send(sub.email, 'One tap to start watching your CHOIVE Score', shell(inner));
}

// Alert when the score moves beyond the threshold.
async function sendAlert(sub, opts) {
  const delta = opts.newScore - opts.previousScore;
  const dir = delta > 0 ? 'went up' : 'went down';
  const arrow = delta > 0 ? '▲' : '▼';
  const color = delta > 0 ? '#10b981' : '#ef4444';
  const resultUrl = site() + '/result?jobId=' + encodeURIComponent(opts.jobId || sub.job_id);
  const unsubUrl = site() + '/.netlify/functions/monitor-unsubscribe?token=' + encodeURIComponent(sub.unsubscribe_token);
  const name = sub.business_name || 'your business';
  const inner = [
    '<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;font-style:italic;margin:0 0 8px;line-height:1.3;">Your CHOIVE Score ' + dir + '.</h1>',
    '<p style="font-size:14px;line-height:1.8;color:#6E6E76;margin:0 0 20px;">' + esc(name) + '</p>',
    '<div style="display:flex;align-items:center;gap:16px;margin:0 0 24px;">',
    '<div style="font-size:40px;font-weight:700;color:' + color + ';">' + opts.newScore + '</div>',
    '<div style="font-size:14px;color:' + color + ';font-weight:600;">' + arrow + ' ' + Math.abs(delta) + ' points<br><span style="color:#BBBBC2;font-weight:400;">was ' + opts.previousScore + '</span></div>',
    '</div>',
    button(resultUrl, 'View the full result →'),
    '<p style="font-size:12px;color:#BBBBC2;margin-top:40px;line-height:1.7;">You get this email because you asked CHOIVE to watch this business. <a href="' + unsubUrl + '" style="color:#C9A86A;">Stop watching</a>.</p>'
  ].join('');
  return send(sub.email, 'CHOIVE Score ' + dir + ' ' + arrow + ' ' + Math.abs(delta) + ' pts — ' + name, shell(inner));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { send, sendConfirmation, sendAlert };
