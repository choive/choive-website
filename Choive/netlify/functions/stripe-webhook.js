// stripe-webhook.js
// CHOIVE™ Stripe webhook handler
// Listens for checkout.session.completed — marks diagnostic paid in Supabase
// regardless of what the client browser does after payment.
// This makes payment recording 100% reliable.
//
// Setup:
// 1. In Stripe Dashboard → Webhooks → Add endpoint
//    URL: https://choive.com/.netlify/functions/stripe-webhook
//    Events: checkout.session.completed
// 2. Copy the Signing Secret into Netlify env as STRIPE_WEBHOOK_SECRET
//
// ENV: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

const { markDiagnosticPaid, saveLead } = require('./lib/supabase');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Verify Stripe webhook signature to confirm the request is genuinely from Stripe
// and not a spoofed request from anyone who knows the endpoint URL.
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  var parts = sigHeader.split(',');
  var timestamp = '';
  var signatures = [];

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (part.startsWith('t=')) timestamp = part.slice(2);
    if (part.startsWith('v1=')) signatures.push(part.slice(3));
  }

  if (!timestamp || signatures.length === 0) return false;

  // Check timestamp is within 5 minutes to prevent replay attacks
  var ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    console.warn('stripe-webhook: timestamp too old — possible replay attack');
    return false;
  }

  var signedPayload = timestamp + '.' + payload;

  // Compute HMAC-SHA256
  var encoder = new TextEncoder();
  var keyData = encoder.encode(secret);
  var msgData = encoder.encode(signedPayload);

  var cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  var sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  var computed = Array.from(new Uint8Array(sig))
    .map(function(b) { return b.toString(16).padStart(2, '0'); })
    .join('');

  return signatures.some(function(s) { return s === computed; });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  var stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeKey) {
    console.error('stripe-webhook: STRIPE_SECRET_KEY not configured');
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Not configured' }) };
  }

  // Verify Stripe webhook signature — REQUIRED for security
  // Without this, anyone who knows the endpoint URL can fake a payment
  if (!webhookSecret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET not set — rejecting request');
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Webhook not configured' }) };
  }

  var sigHeader = event.headers['stripe-signature'];
  var rawBody = event.body || '';
  var valid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!valid) {
    console.error('stripe-webhook: signature verification failed');
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  var stripeEvent;
  try {
    stripeEvent = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Only handle checkout.session.completed
  if (stripeEvent.type !== 'checkout.session.completed') {
    console.log('stripe-webhook: ignoring event type:', stripeEvent.type);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ received: true }) };
  }

  var session = stripeEvent.data && stripeEvent.data.object;
  if (!session) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No session object' }) };
  }

  // Only process paid sessions
  if (session.payment_status !== 'paid') {
    console.log('stripe-webhook: session not paid:', session.payment_status);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ received: true }) };
  }

  // Get jobId from client_reference_id (set when user clicks Unlock)
  var jobId = session.client_reference_id || (session.metadata && session.metadata.jobId) || null;
  var customerEmail = session.customer_details && session.customer_details.email;

  console.log('stripe-webhook: checkout.session.completed', {
    sessionId: session.id,
    jobId: jobId,
    email: customerEmail,
    amount: session.amount_total
  });

  if (!jobId || typeof jobId !== 'string' || !jobId.trim()) {
    console.error('stripe-webhook: no jobId in session', session.id);
    // Still return 200 so Stripe does not retry — this is a data issue, not a webhook issue
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        received: true,
        warning: 'Payment received but no jobId found — manual review needed for session: ' + session.id
      })
    };
  }

  // Mark diagnostic as paid in Supabase
  try {
    await markDiagnosticPaid(jobId.trim());
    console.log('stripe-webhook: marked paid for jobId', jobId);
  } catch (err) {
    console.error('stripe-webhook: markDiagnosticPaid failed:', err.message);
    // Return 500 so Stripe retries — this is a real failure we want to recover
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to mark diagnostic paid: ' + err.message })
    };
  }

  // Save lead if we have an email (best-effort, does not block response)
  if (customerEmail) {
    try {
      await saveLead({
        email: customerEmail,
        jobId: jobId,
        source: 'stripe_checkout',
        name: session.customer_details && session.customer_details.name || '',
        amount: session.amount_total || 0,
        currency: session.currency || 'eur'
      });
      console.log('stripe-webhook: lead saved for', customerEmail);
    } catch (err) {
      console.warn('stripe-webhook: lead save failed (non-critical):', err.message);
    }
  }

  // Check if this is a Report payment ($499) — trigger report generation
  var productType = (session.metadata && session.metadata.product_type) || '';
  var amountTotal = session.amount_total || 0;
  var isReportPayment = productType === 'report' || amountTotal >= 49900;

  if (isReportPayment && customerEmail) {
    console.log('stripe-webhook: Report payment detected — triggering generate-report');
    try {
      var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
      var generateUrl = siteUrl + '/.netlify/functions/generate-report';
      fetch(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId, email: customerEmail })
      }).then(function(gr) {
        return gr.json().then(function(gd) {
          console.log('stripe-webhook: generate-report response:', JSON.stringify(gd));
        });
      }).catch(function(ge) {
        console.error('stripe-webhook: generate-report trigger failed:', ge.message);
      });
    } catch (err) {
      console.warn('stripe-webhook: could not trigger report generation:', err.message);
    }
  }

  // Send confirmation email (best-effort, does not block response)
  if (customerEmail && process.env.RESEND_API_KEY) {
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
          to: [customerEmail],
          subject: 'Your CHOIVE Analysis is ready',
          html: [
            '<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#0C0C0E;">',
            '<div style="font-size:18px;font-weight:700;letter-spacing:0.08em;margin-bottom:32px;">CHOIVE<span style="color:#C9A86A;">·</span></div>',
            '<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:400;font-style:italic;margin:0 0 16px;line-height:1.3;">Your full analysis is ready.</h1>',
            '<p style="font-size:14px;line-height:1.8;color:#6E6E76;margin:0 0 32px;">',
            'Thank you for unlocking your CHOIVE Analysis. Your complete diagnostic — including competitor intelligence, pillar breakdown with evidence, priority actions, and ready-to-use assets — is waiting for you.',
            '</p>',
            '<a href="' + resultUrl + '" style="display:inline-block;background:#C9A86A;color:#0C0C0E;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:0.06em;padding:14px 28px;">',
            'View Your Full Analysis →',
            '</a>',
            '<p style="font-size:12px;color:#BBBBC2;margin-top:40px;line-height:1.7;">',
            'This link is unique to your diagnostic. Keep it to return to your results at any time.<br>',
            'Questions? Reply to this email or contact <a href="mailto:hello@choive.com" style="color:#C9A86A;">hello@choive.com</a>',
            '</p>',
            '<div style="margin-top:32px;padding-top:24px;border-top:1px solid #F5F2EE;font-size:11px;color:#BBBBC2;">',
            'CHOIVE· — Be the answer. Not the alternative.',
            '</div>',
            '</div>'
          ].join('')
        })
      });
      console.log('stripe-webhook: confirmation email sent to', customerEmail);
    } catch (err) {
      console.warn('stripe-webhook: email send failed (non-critical):', err.message);
    }
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ received: true, jobId: jobId })
  };
};
