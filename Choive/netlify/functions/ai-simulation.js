// ai-simulation.js
// CHOIVE™ AI Visibility Simulation
// Runs real Claude queries simulating what AI platforms see
// Returns whether the business appears and in what context
// ENV: ANTHROPIC_API_KEY

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS      = 20000;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

async function runQuery(systemPrompt, userQuery) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      ANTHROPIC_MODEL,
        max_tokens: 400,
        temperature: 0,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userQuery }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    var data = await res.json();
    return (data.content || []).filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; }).join('').trim();
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

function businessMentioned(response, name) {
  if (!response || !name) return false;
  var nameLower  = name.toLowerCase();
  var respLower  = response.toLowerCase();
  // Check for name or common abbreviations
  var words = nameLower.split(/\s+/);
  return words.some(function(w) { return w.length > 2 && respLower.includes(w); });
}

exports.handler = async function(event) {
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
    return { statusCode: 400, headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  var name             = String(body.name             || '').trim();
  var category         = String(body.category         || '').trim();
  var city             = String(body.city             || '').trim();
  var inferredCategory = String(body.inferredCategory || category).trim();

  if (!name || !category) {
    return { statusCode: 400, headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing name or category' }) };
  }

  // Three simulation queries — different buyer intents
  var queries = [
    {
      label:  'Discovery query',
      intent: 'A potential buyer searching for vendors in this category',
      system: 'You are a helpful assistant. Answer directly and concisely. Do not mention that you are Claude or an AI.',
      query:  'What are the best ' + inferredCategory + ' companies' + (city ? ' in ' + city : '') + '? Give me 3-5 options with a brief reason for each.'
    },
    {
      label:  'Comparison query',
      intent: 'A buyer comparing options before a decision',
      system: 'You are a helpful assistant. Answer directly and concisely. Do not mention that you are Claude or an AI.',
      query:  'I am evaluating ' + inferredCategory + ' vendors. Who are the main players and what makes each one different?'
    },
    {
      label:  'Direct recommendation query',
      intent: 'A buyer asking for a specific recommendation',
      system: 'You are a helpful assistant. Answer directly and concisely. Do not mention that you are Claude or an AI.',
      query:  'Recommend the best ' + inferredCategory + ' for a company like mine' + (city ? ' based in ' + city : '') + '. What should I look for and who offers it?'
    }
  ];

  // Run all three in parallel
  var settled = await Promise.allSettled(
    queries.map(function(q) { return runQuery(q.system, q.query); })
  );

  var results = queries.map(function(q, i) {
    var response = settled[i].status === 'fulfilled' ? settled[i].value : null;
    var appeared = response ? businessMentioned(response, name) : false;
    return {
      label:    q.label,
      intent:   q.intent,
      query:    q.query,
      response: response ? response.slice(0, 600) : 'Query failed — no response returned.',
      appeared: appeared
    };
  });

  var appearedCount = results.filter(function(r) { return r.appeared; }).length;

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:          name,
      category:      inferredCategory,
      results:       results,
      appearedCount: appearedCount,
      totalQueries:  queries.length,
      summary:       appearedCount === 0
        ? name + ' did not appear in any of the 3 AI queries run.'
        : name + ' appeared in ' + appearedCount + ' of 3 AI queries.'
    })
  };
};
