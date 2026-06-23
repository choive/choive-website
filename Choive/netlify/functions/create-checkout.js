// create-checkout.js
// CHOIVE™ — Creates a Stripe Checkout Session server-side
// Returns a checkout URL with success_url and cancel_url set
// This is the ONLY reliable way to redirect back after payment
// ENV: STRIPE_SECRET_KEY, URL

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
  if (!jobId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing jobId' })
    };
  }

  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
  var successUrl = siteUrl + '/?jobId=' + encodeURIComponent(jobId) + '&paid=1&session_id={CHECKOUT_SESSION_ID}';
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
        'line_items[0][price_data][currency]':              'usd',
        'line_items[0][price_data][product_data][name]':    'CHOIVE Analysis™',
        'line_items[0][price_data][product_data][description]': 'Full AI selection analysis — competitor intelligence, priority actions, ready-to-use assets.',
        'line_items[0][price_data][unit_amount]':           '9900',
        'line_items[0][quantity]':                          '1',
        'payment_intent_data[metadata][jobId]':             jobId,
        'metadata[jobId]':                                  jobId
      }).toString()
    });

    if (!res.ok) {
      var err = await res.json();
      console.error('create-checkout: Stripe error:', err);
      return {
        statusCode: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.error?.message || 'Stripe checkout failed' })
      };
    }

    var session = await res.json();
    console.log('create-checkout: session created', session.id, 'for jobId', jobId);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, sessionId: session.id })
    };

  } catch (err) {
    console.error('create-checkout: error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not create checkout session' })
    };
  }
};
