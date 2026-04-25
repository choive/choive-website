// verify-payment.js
// Verifies a Stripe Checkout Session and returns the original CHOIVE jobId
// ENV: STRIPE_SECRET_KEY

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const sessionId = event.queryStringParameters?.session_id;

  if (!sessionId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing session_id' })
    };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Stripe not configured' })
    };
  }

  try {
    // Retrieve the Checkout Session from Stripe
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const session = await res.json();

    if (!res.ok) {
      console.error('Stripe API error:', session?.error?.message);
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: session?.error?.message || 'Stripe error' })
      };
    }

    // Verify payment is complete
    if (session.payment_status !== 'paid') {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false, error: 'Payment not complete' })
      };
    }

    // client_reference_id = the CHOIVE jobId passed when user clicked unlock
    const jobId = session.client_reference_id;

    if (!jobId) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: true, error: 'No jobId in session' })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: true, jobId })
    };

  } catch (err) {
    console.error('verify-payment error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Verification failed' })
    };
  }
};
