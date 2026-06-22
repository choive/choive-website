// save-lead.js
// CHOIVE™ — Email lead capture from free result page
// Saves email + jobId to Supabase leads table
// Optionally sends a "your report link" email via Resend
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (optional)

const { saveLead } = require('./lib/supabase');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Invalid JSON' })
    };
  }

  var email  = String(body.email  || '').trim().toLowerCase();
  var jobId  = String(body.jobId  || '').trim();
  var source = String(body.source || 'free_result').trim();

  if (!email || !email.includes('@') || !email.includes('.')) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Invalid email address' })
    };
  }

  // Save to Supabase leads table
  try {
    await saveLead({ email, jobId, source });
    console.log('save-lead: saved', email, source, jobId);
  } catch (err) {
    console.error('save-lead: Supabase failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Could not save. Please try again.' })
    };
  }

  // Send "access your results" email if Resend is configured
  if (process.env.RESEND_API_KEY && jobId) {
    try {
      var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
      var resultUrl = siteUrl + '/?jobId=' + encodeURIComponent(jobId);

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'CHOIVE <hello@choive.com>',
          to: [email],
          subject: 'Your CHOIVE diagnostic result',
          html: [
            '<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#0C0C0E;">',
            '<div style="font-size:18px;font-weight:700;letter-spacing:0.08em;margin-bottom:32px;">CHOIVE<span style="color:#C9A86A;">·</span></div>',
            '<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;font-style:italic;margin:0 0 16px;line-height:1.3;">Here\'s your diagnostic result.</h1>',
            '<p style="font-size:14px;line-height:1.8;color:#6E6E76;margin:0 0 24px;">',
            'Your CHOIVE Index score is ready. Click the link below to view your free result — and see exactly where your business stands on AI platforms like ChatGPT, Perplexity, Gemini, and Claude.',
            '</p>',
            '<a href="' + resultUrl + '" style="display:inline-block;background:#C9A86A;color:#0C0C0E;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:0.06em;padding:14px 28px;">',
            'View Your Diagnostic Result →',
            '</a>',
            '<p style="font-size:12px;color:#BBBBC2;margin-top:40px;line-height:1.7;">',
            'Want to unlock the full analysis? Click the link above and select "Unlock Full Analysis" on your result page.<br>',
            'Questions? Contact <a href="mailto:hello@choive.com" style="color:#C9A86A;">hello@choive.com</a>',
            '</p>',
            '<div style="margin-top:32px;padding-top:24px;border-top:1px solid #F5F2EE;font-size:11px;color:#BBBBC2;">',
            'CHOIVE· — Be the answer. Not the alternative.',
            '</div>',
            '</div>'
          ].join('')
        })
      });
      console.log('save-lead: result link sent to', email);
    } catch (err) {
      // Email failure is non-critical — lead is already saved
      console.warn('save-lead: email send failed (non-critical):', err.message);
    }
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
