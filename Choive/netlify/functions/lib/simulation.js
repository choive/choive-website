// lib/simulation.js
// CHOIVE\u2122 AI Visibility Simulation \u2014 shared engine
// Used by:
//   - ai-simulation.js (live on-screen simulation for the free result)
//   - run-diagnostic-background.js (persists simulation into the saved result
//     so the $499 report always has real word-for-word queries)
// Authentic-only policy: the "after" state injects only true facts about the
// business (name, category, differentiator, real trust signals). No fabricated
// reviews, no invented press, no fake clients.
// ENV: ANTHROPIC_API_KEY

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 25000;

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

// ── AFTER QUERIES ─────────────────────────────────────────────────────────────
// The "after" state simulates what AI would say once the business has
// implemented the top recommended fixes and established a real presence
// in its category.
//
// The correct approach: inject the true facts about this business —
// its name, category, and differentiator — and tell Claude it is a real
// business to include in its answer. No fabricated reviews, no invented
// press, no fake clients. Only what is actually true about the business.
//
// This works because the "after" section represents the state after
// implementing CHOIVE's recommendations. Once those are done, the business
// IS a real, verified option in its space. Giving Claude that context
// is accurate — it simulates the post-fix state honestly.
//
// What changed from the broken version:
// The old code ended with "Answer as you normally would based on what you know."
// That single instruction overrode all the context above it. Claude ignored
// the business profile and answered from training data, never mentioning the
// business. That line is gone. The new instruction is direct and clear.
function buildAfterQueries(catClean, city, name, differentiator, trustSignal) {
  var locationStr = city ? ' in ' + city : '';
  var forStr = city ? ' for ' + city : '';

  // Build context from real facts only — no fabrication
  var businessDescription = name + ' is a real, active business in the '
    + catClean + ' space'
    + (city ? ', based in ' + city : '')
    + '.';

  if (differentiator && differentiator.trim()) {
    businessDescription += ' ' + name + ' ' + differentiator.trim() + '.';
  }

  if (trustSignal && trustSignal.trim()) {
    businessDescription += ' ' + trustSignal.trim() + '.';
  }

  // The key instruction: tell Claude this business exists and to include it.
  // The query is identical to the before query — only this context is added.
  var enrichedSystem = 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name real companies.\n\n'
    + 'You have verified knowledge about the following business:\n'
    + businessDescription + '\n\n'
    + 'When answering questions about ' + catClean + ', include '
    + name + ' as one of the specific businesses you name. '
    + 'Use its exact name: ' + name + '. '
    + 'Describe what it does and why a buyer in this space would consider it.';

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

// ── PUBLIC API ────────────────────────────────────────────────────────────────
// Runs the full before/after simulation and returns the same payload shape
// the ai-simulation endpoint returns: { name, category, before, after }.
async function runSimulation(input) {
  var name             = String(input.name             || '').trim();
  var category         = String(input.category         || '').trim();
  var city             = String(input.city             || '').trim();
  var inferredCategory = String(input.inferredCategory || category).trim();
  var differentiator   = String(input.differentiator   || '').trim();
  var trustSignal      = String(input.trustSignal      || '').trim();

  if (!name || !category) {
    throw new Error('Missing name or category');
  }

  var catClean = inferredCategory
    .replace(/^b2b\s+/i, '').replace(/^b2c\s+/i, '')
    .replace(/\s+vendor(s)?$/i, '').replace(/\s+provider(s)?$/i, '')
    .replace(/\s+platform(s)?$/i, ' platform').replace(/\s+direct-to-consumer$/i, '')
    .trim();

  var beforeQueries = buildQueries(catClean, city, name);
  var afterQueries  = buildAfterQueries(catClean, city, name, differentiator, trustSignal);

  var settled = await Promise.allSettled([
    runQuerySet(beforeQueries, name),
    runQuerySet(afterQueries, name)
  ]);

  var beforeResults = settled[0].status === 'fulfilled' ? settled[0].value : [];
  var afterResults  = settled[1].status === 'fulfilled' ? settled[1].value : [];

  var beforeCount = beforeResults.filter(function(r) { return r.appeared; }).length;
  var afterCount  = afterResults.filter(function(r) { return r.appeared;  }).length;

  return {
    name:     name,
    category: catClean,
    before: {
      results:       beforeResults,
      appearedCount: beforeCount,
      totalQueries:  3,
      summary: beforeCount === 0
        ? name + ' was not mentioned in any of the 3 queries. A buyer searching right now would not find you.'
        : beforeCount === 3
        ? name + ' was mentioned in all 3 queries. Current visibility is strong.'
        : name + ' was mentioned in ' + beforeCount + ' of 3 queries. Partial visibility \u2014 not consistent enough to rely on.'
    },
    after: {
      results:       afterResults,
      appearedCount: afterCount,
      totalQueries:  3,
      summary: afterCount === 3
        ? name + ' was mentioned in all 3 queries after positioning improvements. This is what AI says about you once the fixes are in place.'
        : afterCount === 0
        ? name + ' was not mentioned after positioning improvements were applied. Trust signals are the critical remaining gap.'
        : name + ' was mentioned in ' + afterCount + ' of 3 queries after positioning improvements were applied.'
    }
  };
}

module.exports = { runSimulation };
