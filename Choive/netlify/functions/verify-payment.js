// verify-payment.js
// Verifies a Stripe Checkout Session and returns the original CHOIVE jobId
// ENV: STRIPE_SECRET_KEY

const { markDiagnosticPaid } = require('./lib/supabase');

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
    // Prefer client_reference_id; optionally fall back to session.metadata.jobId
    const jobId = session.client_reference_id || session.metadata?.jobId || null;

    // Validate jobId exists and is a non-empty string
    if (!jobId || typeof jobId !== 'string' || !jobId.trim()) {
      console.error('verify-payment: jobId missing or malformed in session', session.id);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paid: false,
          error: 'Payment received but could not link to your diagnostic. Contact hello@choive.com with your payment reference.'
        })
      };
    }

    // Mark diagnostic as paid in Supabase
    // If the diagnostic row does not exist, this will throw and return a 400
    try {
      await markDiagnosticPaid(jobId);
      console.log('verify-payment: marked paid for jobId', jobId);
    } catch (err) {
      console.error('verify-payment: markDiagnosticPaid failed:', err.message);
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paid:  false,
          error: err.message
        })
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
