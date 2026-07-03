// ai-simulation.js
// CHOIVE™ AI Visibility Simulation — HTTP endpoint
// Runs BEFORE queries (current state) and AFTER queries (optimised state)
// Shows the business owner what changes if they implement the top fixes.
// All simulation logic lives in lib/simulation.js — shared with the
// background diagnostic pipeline so the free result and the paid report
// always show the same word-for-word queries.
// ENV: ANTHROPIC_API_KEY

const { runSimulation } = require('./lib/simulation');

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

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    var payload = await runSimulation(body);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    var isInput = /Missing name or category/.test(err.message || '');
    return {
      statusCode: isInput ? 400 : 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message || 'Simulation failed' })
    };
  }
};
