// create-report-checkout.js
// CHOIVE™ — Creates a $499 Stripe Checkout Session for the CHOIVE Report
// Passes jobId and product_type:'report' so webhook can trigger PDF generation
// ENV: STRIPE_SECRET_KEY, URL

const { getDiagnostic } = require('./lib/supabase');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Stripe not configured' })
    };
  }

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  var jobId = String(body.jobId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing or invalid jobId' })
    };
  }
  try {
    var diagnostic = await getDiagnostic(jobId);
    if (!diagnostic || diagnostic.status !== 'complete') {
      return {
        statusCode: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'The diagnostic must be complete before checkout.' })
      };
    }
  } catch (lookupError) {
    console.error('create-report-checkout: diagnostic lookup failed:', lookupError.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not verify diagnostic before checkout' })
    };
  }

  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
  // After payment — redirect back to result with report=pending flag
  var successUrl = siteUrl + '/?jobId=' + encodeURIComponent(jobId) + '&paid=1&report=1&session_id={CHECKOUT_SESSION_ID}';
  var cancelUrl  = siteUrl + '/?jobId=' + encodeURIComponent(jobId);

  try {
    var res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode':                        'payment',
        'success_url':                 successUrl,
        'cancel_url':                  cancelUrl,
        'client_reference_id':         jobId,
        // product_type in metadata — webhook reads this to know it's a Report
        'metadata[jobId]':             jobId,
        'metadata[product_type]':      'report',
        'payment_intent_data[metadata][jobId]':        jobId,
        'payment_intent_data[metadata][product_type]': 'report',
        'line_items[0][price_data][currency]':              'usd',
        'line_items[0][price_data][product_data][name]':    'CHOIVE· Report',
        'line_items[0][price_data][product_data][description]': 'Complete AI selection report — scored across Clarity, Trust, Difference, and Ease. Competitor intelligence, AI simulation, 30-day action plan, and ready-to-use assets. Delivered as a branded PDF to your inbox within minutes of payment.',
        'line_items[0][price_data][unit_amount]':           '49900',
        'line_items[0][quantity]':                          '1',
      }).toString()
    });

    if (!res.ok) {
      var err = await res.json();
      console.error('create-report-checkout: Stripe error:', err);
      return {
        statusCode: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.error?.message || 'Stripe checkout failed' })
      };
    }

    var session = await res.json();
    console.log('create-report-checkout: session created', session.id, 'for jobId', jobId);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, sessionId: session.id })
    };

  } catch (err) {
    console.error('create-report-checkout: error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not create checkout session' })
    };
  }
};
