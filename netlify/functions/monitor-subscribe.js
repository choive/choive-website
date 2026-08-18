/**
 * CHOIVE Score Monitoring Subscription Endpoint
 * 
 * Allows businesses to subscribe to automated CHOIVE Score monitoring.
 * Tracks score changes and sends alerts when performance shifts.
 * 
 * POST body:
 * {
 *   "business": "business-identifier",
 *   "email": "user@example.com",
 *   "frequency": "weekly" | "monthly",
 *   "threshold": 5  // minimum score change to trigger alert
 * }
 */

exports.handler = async (event) => {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }
  
  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }
  
  const { business, email, frequency, threshold } = data;
  
  // Validation
  if (!business || !email) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required fields: business, email' })
    };
  }
  
  if (!['weekly', 'monthly'].includes(frequency)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid frequency. Must be "weekly" or "monthly".' })
    };
  }
  
  const changeThreshold = parseInt(threshold, 10) || 5;
  
  if (changeThreshold < 1 || changeThreshold > 50) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid threshold. Must be between 1-50.' })
    };
  }
  
  // TODO: In production, store subscription in database
  // For now, log the subscription
  console.log('MONITOR SUBSCRIPTION:', {
    business,
    email,
    frequency,
    threshold: changeThreshold,
    subscribedAt: new Date().toISOString()
  });
  
  // TODO: Send confirmation email
  // TODO: Schedule first check based on frequency
  
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      success: true,
      message: 'Monitoring subscription created',
      subscription: {
        business,
        email,
        frequency,
        threshold: changeThreshold,
        nextCheck: getNextCheckDate(frequency)
      }
    })
  };
};

function getNextCheckDate(frequency) {
  const now = new Date();
  const next = new Date(now);
  
  if (frequency === 'weekly') {
    next.setDate(now.getDate() + 7);
  } else if (frequency === 'monthly') {
    next.setMonth(now.getMonth() + 1);
  }
  
  return next.toISOString().split('T')[0];
}
