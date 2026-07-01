// ai-simulation.js
// CHOIVE™ AI Visibility Simulation
// Runs BEFORE queries (current state) and AFTER queries (optimised state)
// Shows the business owner what changes if they implement the top fixes
// ENV: ANTHROPIC_API_KEY

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 25000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
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
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userQuery }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      var errText = await res.text().catch(function() { return ''; });
      console.warn('[ai-simulation] API returned', res.status, errText.slice(0, 200));
      return null;
    }
    var data = await res.json();
    return (data.content || []).filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; }).join('').trim();
  } catch (err) {
    clearTimeout(timer);
    console.warn('[ai-simulation] runQuery failed:', err.message);
    return null;
  }
}

function cleanResponse(response) {
  if (!response) return 'Query failed.';
  var cleaned = response
    .replace(/[#]+ /g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*] /gm, '\u2022 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length > 500) {
    var cut = cleaned.lastIndexOf('.', 500);
    cleaned = cut > 150 ? cleaned.slice(0, cut + 1) : cleaned.slice(0, 500);
  }
  return cleaned;
}

// Detects whether the business actually appears in the AI's response.
// Primary check requires the full name as a phrase — the strongest signal.
// Fallback (for cases with minor name variation) requires ALL significant
// words in the name to appear, not just any single word. A single shared
// word (e.g. "Panorama" appearing in an unrelated sentence about scenery)
// must not register as a false positive "appearance."
function businessMentioned(response, name) {
  if (!response || !name) return false;
  var respLower = response.toLowerCase();
  var nameLower = name.toLowerCase().trim();

  if (respLower.includes(nameLower)) return true;

  var words = nameLower.split(/\s+/).filter(function(w) { return w.length > 2; });
  if (words.length === 0) return false;
  if (words.length === 1) return respLower.includes(words[0]);
  return words.every(function(w) { return respLower.includes(w); });
}

function buildQueries(catClean, city, name) {
  var locationStr = city ? ' in ' + city : '';
  var forStr = city ? ' for ' + city : '';
  return [
    {
      label: 'Discovery query',
      intent: 'A potential buyer searching for options',
      system: 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name real companies.',
      query: 'What are the best ' + catClean + ' options' + locationStr + '? I need 3-5 recommendations with a brief reason for each.'
    },
    {
      label: 'Comparison query',
      intent: 'A buyer evaluating alternatives',
      system: 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name real companies.',
      query: 'I am comparing ' + catClean + ' options. Who are the main players and what makes each one stand out?'
    },
    {
      label: 'Direct recommendation',
      intent: 'A buyer ready to decide',
      system: 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name real companies.',
      query: 'Which ' + catClean + ' would you recommend' + forStr + '? Just give me your top pick and why.'
    }
  ];
}

function buildAfterQueries(catClean, city, name, differentiator, trustSignal) {
  var locationStr = city ? ' in ' + city : '';
  var forStr = city ? ' for ' + city : '';

  // Only include signals that are real and provided — never invent signals.
  // The "after" state must be an honest projection based on actual confirmed
  // signals, not a fabricated best-case scenario that misleads the owner.
  var knownSignals = [];
  if (differentiator && differentiator.trim()) {
    knownSignals.push('- Differentiator: ' + differentiator.trim());
  }
  if (trustSignal && trustSignal.trim()) {
    knownSignals.push('- Trust signal: ' + trustSignal.trim());
  }

  var enrichedSystem = 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name real companies.\n\n'
    + (knownSignals.length > 0
      ? 'You have access to the following confirmed information about ' + name + ':\n'
        + '- Category: ' + catClean + (city ? ', based in ' + city : '') + '\n'
        + knownSignals.join('\n') + '\n'
        + 'Use this information naturally in your answer only if it is directly relevant.\n\n'
      : '')
    + 'Answer as you normally would based on what you know.';

  return [
    {
      label: 'Discovery query',
      intent: 'A potential buyer searching for options',
      system: enrichedSystem,
      query: 'What are the best ' + catClean + ' options' + locationStr + '? I need 3-5 recommendations with a brief reason for each.'
    },
    {
      label: 'Comparison query',
      intent: 'A buyer evaluating alternatives',
      system: enrichedSystem,
      query: 'I am comparing ' + catClean + ' options. Who are the main players and what makes each one stand out?'
    },
    {
      label: 'Direct recommendation',
      intent: 'A buyer ready to decide',
      system: enrichedSystem,
      query: 'Which ' + catClean + ' would you recommend' + forStr + '? Just give me your top pick and why.'
    }
  ];
}

async function runQuerySet(queries, name) {
  var settled = await Promise.allSettled(
    queries.map(function(q) { return runQuery(q.system, q.query); })
  );
  return queries.map(function(q, i) {
    var response = settled[i].status === 'fulfilled' ? settled[i].value : null;
    var cleaned = cleanResponse(response);
    return {
      label: q.label,
      intent: q.intent,
      query: q.query,
      response: cleaned,
      appeared: businessMentioned(cleaned, name)
    };
  });
}

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

  var name = String(body.name || '').trim();
  var category = String(body.category || '').trim();
  var city = String(body.city || '').trim();
  var inferredCategory = String(body.inferredCategory || category).trim();
  var differentiator = String(body.differentiator || '').trim();
  var trustSignal = String(body.trustSignal || '').trim();

  if (!name || !category) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing name or category' }) };
  }

  var catClean = inferredCategory
    .replace(/^b2b\s+/i, '').replace(/^b2c\s+/i, '')
    .replace(/\s+vendor(s)?$/i, '').replace(/\s+provider(s)?$/i, '')
    .replace(/\s+platform(s)?$/i, ' platform').replace(/\s+direct-to-consumer$/i, '')
    .trim();

  var beforeQueries = buildQueries(catClean, city, name);
  var afterQueries = buildAfterQueries(catClean, city, name, differentiator, trustSignal);

  var settled = await Promise.allSettled([
    runQuerySet(beforeQueries, name),
    runQuerySet(afterQueries, name)
  ]);

  var beforeResults = settled[0].status === 'fulfilled' ? settled[0].value : [];
  var afterResults = settled[1].status === 'fulfilled' ? settled[1].value : [];

  var beforeCount = beforeResults.filter(function(r) { return r.appeared; }).length;
  var afterCount = afterResults.filter(function(r) { return r.appeared; }).length;

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name,
      category: catClean,
      before: {
        results: beforeResults,
        appearedCount: beforeCount,
        totalQueries: 3,
        summary: beforeCount === 0
          ? name + ' did not appear in any of the 3 queries. A buyer searching right now would not find you.'
          : beforeCount === 3
          ? name + ' appeared in all 3 queries. Current visibility is strong.'
          : name + ' appeared in ' + beforeCount + ' of 3 queries. Partial visibility — not consistent enough to rely on.'
      },
      after: {
        results: afterResults,
        appearedCount: afterCount,
        totalQueries: 3,
        summary: afterCount === 0
          ? name + ' did not appear after known signals were applied. Trust signals are the critical gap.'
          : afterCount === 3
          ? name + ' appeared in all 3 queries after known signals were applied. Full visibility achievable.'
          : name + ' appeared in ' + afterCount + ' of 3 queries after known signals were applied.'
      }
    })
  };
};
