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
// Hardened mention detection: folds diacritics (Täurbull → taurbull), strips
// legal suffixes (GmbH, Ltd, Inc…) and possessives, matches on word boundaries,
// and tolerates spacing variants (TaurBull vs Taur Bull). The old scatter-match
// (every word anywhere in the text) is gone — it produced false positives for
// generic names like Casa Verde.
var LEGAL_SUFFIX_RE = /\b(gmbh|ag|kg|ug|ohg|gbr|ek|inc|llc|llp|ltd|limited|corp|corporation|co|company|s\s?a\s?r\s?l|sarl|sas|sa|bv|nv|srl|spa|oy|ab|as|aps|plc|pty|kft|sro|doo|kk|gk)\b/g;

function normalizeForMatch(s) {
  s = String(s || '').toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
  s = s.replace(/\u00df/g, 'ss');
  s = s.replace(/['\u2019]s\b/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function businessMentioned(response, name) {
  if (!response || !name) return false;
  var resp = ' ' + normalizeForMatch(response) + ' ';
  var respNoSpace = resp.replace(/ /g, '');
  var full = normalizeForMatch(name);
  var core = full.replace(LEGAL_SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim();
  var candidates = [full, core].filter(function(v, i, a) { return v && a.indexOf(v) === i; });
  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    if (resp.indexOf(' ' + cand + ' ') !== -1) return true;
    if (cand.indexOf(' ') !== -1 && respNoSpace.indexOf(cand.replace(/ /g, '')) !== -1) return true;
  }
  return false;
}

// Deterministic relevance guard: a generated "buyer" query must actually be
// ABOUT the category, not a generic vendor-shopping question that happens to
// name no one. Same fidelity test used for category-label drift, applied here
// to catch query-drift — "which vendor is the best fit for my needs" passes
// no platform filter and looks like buyer language, but it isn't asking about
// this category at all, so an empty result proves nothing.
// GENERIC-SHOPPING BLOCKLIST: phrases that mark a query as "help me pick
// ANY vendor" rather than about a specific category. This is the actual
// signature of the observed bug — catches it regardless of category wording.
var GENERIC_SHOPPING_RE = /\b(best fit for my (specific )?business needs|which vendor|which solution is (actually )?the best|help me (figure out |choose |pick )?which (vendor|solution|software|tool) (is|to)|which (software|platform) (should|to) (i )?(use|choose|pick))\b/i;

function queryOnCategory(query, catClean) {
  var q = String(query || '');
  if (GENERIC_SHOPPING_RE.test(q)) return false;
  // Token overlap is a BONUS signal, not a requirement — genuine buyer
  // language ("how do I get recommended by ChatGPT") legitimately shares no
  // word with a coined category label like "AI selection diagnostic", and
  // must not be penalized for using the buyer's words instead of the vendor's.
  var stop = { the:1, and:1, for:1, with:1, from:1, that:1, this:1, what:1, which:1, who:1, best:1, are:1, can:1, help:1, use:1, need:1, actually:1, specific:1, business:1, needs:1, solution:1, vendor:1, tool:1, tools:1, platform:1, options:1, choose:1, choosing:1, right:1, good:1, way:1, want:1, looking:1, find:1, get:1, should:1, could:1, would:1 };
  var toks = function(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(function(w) { return w.length > 2 && !stop[w]; });
  };
  var catToks = toks(catClean);
  var qToks = {};
  toks(q).forEach(function(w) { qToks[w] = 1; });
  var overlaps = catToks.some(function(w) {
    if (qToks[w]) return true;
    for (var k in qToks) { if (k.indexOf(w) === 0 || w.indexOf(k) === 0) return true; }
    return false;
  });
  // Pass if EITHER it shares category vocabulary OR it's simply not a
  // generic-shopping question (already filtered above). Reject only the
  // narrow, dangerous middle: short, vague queries with zero category
  // signal that also weren't caught by the explicit pattern.
  if (overlaps) return true;
  return q.split(/\s+/).length >= 8; // a full, specific buyer sentence passes; a bare vague fragment does not
}

async function generateBuyerQueries(n, templates) {
  // Template queries echo the vendor's category label — which breaks for
  // category creators: "best AI selection diagnostic" reads as HR tech to the
  // answering model (the Pymetrics bug). Real buyers ask about their PROBLEM.
  var prompt = 'A business:\n'
    + 'Name: ' + n.name + '\n'
    + 'Category: ' + n.catClean + '\n'
    + (n.city ? 'Market: ' + n.city + '\n' : '')
    + (n.description ? 'Description: ' + String(n.description).slice(0, 300) + '\n' : '')
    + '\nWrite the 3 questions a REAL potential buyer of this kind of offering would type into an AI assistant when looking for help \u2014 before knowing any vendor names.\n'
    + 'Rules:\n'
    + '- FIRST identify who PAYS for this offering and what outcome they want. Write every query from THAT person\u2019s seat.\n'
    + '- Use the words buyers use for their PROBLEM, not the vendor\u2019s own category label if that label is coined or unusual.\n'
    + '- DIRECTION CHECK: if the offering helps businesses get discovered, recommended, visible, or chosen (a marketing-side tool), the buyer is a business owner asking how to make THEIR OWN business get recommended \u2014 e.g. \u201cHow do I get my business recommended by ChatGPT?\u201d or \u201cWhy doesn\u2019t AI mention my company?\u201d \u2014 NOT someone shopping for software to choose things with. Do not invert the transaction.\n'
    + '- Query 1: discovery (looking for options, wants 3-5 recommendations). Query 2: comparison (evaluating the main players). Query 3: decision (wants one pick).\n'
    + '- Never mention ' + n.name + ' or any specific vendor.\n'
    + '- Natural buyer phrasing, one sentence each.\n'
    + 'Respond ONLY with a JSON array of exactly 3 strings. No markdown.';
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 25000);
  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return templates;
    var data = await res.json();
    var text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('').replace(/```json|```/g, '').trim();
    var arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== 3) return templates;
    var nameLc = n.name.toLowerCase();
    if (arr.some(function(q) { return String(q).toLowerCase().indexOf(nameLc) !== -1; })) return templates;
    var candidates = arr.map(String);
    // Every query must be verifiably about the category. If even one drifts
    // off-topic (the G2/Capterra-shopping pattern), reject the WHOLE set —
    // a mixed set with one bad query still poisons the ground truth — and
    // fall back to the templates, which contain catClean verbatim by construction.
    var allOnTopic = candidates.every(function(q) { return queryOnCategory(q, n.catClean); });
    if (!allOnTopic) {
      console.warn('[simulation] generated queries drifted off-category, using templates:', JSON.stringify(candidates));
      return templates;
    }
    return templates.map(function(t, i) {
      return { label: t.label, intent: t.intent, system: t.system, query: candidates[i] };
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[simulation] buyer-query generation failed, using templates:', err.message);
    return templates;
  }
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

// ── MARKET LANGUAGE ─────────────────────────────────────────────────
// German buyers ask AI in German. Ground truth measured in the wrong language
// is the wrong ground truth. Deterministic keyword table (no extra call); the
// three queries are translated once per run via a small model call, cached
// with the evidence. Any failure falls back to English silently.
var MARKET_LANGS = [
  ['de', /\b(german(y)?|deutschland|berlin|m[u\u00fc]nchen|munich|stuttgart|hamburg|frankfurt|k[o\u00f6]ln|cologne|d[u\u00fc]sseldorf|austria|\u00f6sterreich|wien|vienna|schweiz|switzerland|z[u\u00fc]rich|zurich)\b/],
  ['es', /\b(spain|espa[n\u00f1]a|madrid|barcelona|marbella|valencia|sevilla|m[e\u00e9]xico|mexico|bogot[a\u00e1]|argentina|buenos aires|colombia|chile|per[u\u00fa])\b/],
  ['fr', /\b(france|paris|lyon|marseille|bordeaux|belgi(um|que)|bruxelles|montreal|montr[e\u00e9]al|qu[e\u00e9]bec)\b/],
  ['it', /\b(ital(y|ia)|roma|rome|milan(o)?|torino|napoli)\b/],
  ['nl', /\b(netherlands|nederland|amsterdam|rotterdam|utrecht|den haag)\b/],
  ['pt', /\b(portugal|lisbo[an]|porto|brasil|brazil|s[a\u00e3]o paulo|rio de janeiro)\b/],
  ['pl', /\b(poland|polska|warsaw|warszawa|krak[o\u00f3]w)\b/],
  ['tr', /\b(turkey|t[u\u00fc]rkiye|istanbul|ankara|izmir)\b/],
  ['sv', /\b(sweden|sverige|stockholm|g[o\u00f6]teborg)\b/],
  ['da', /\b(denmark|danmark|copenhagen|k[o\u00f8]benhavn)\b/],
  ['ja', /\b(japan|tokyo|osaka|kyoto)\b/],
  ['ko', /\b(korea|seoul|busan)\b/],
  ['zh', /\b(china|beijing|shanghai|shenzhen|taiwan|taipei)\b/],
  ['ar', /\b(saudi|riyadh|jeddah|egypt|cairo|jordan|amman|kuwait|qatar|doha|bahrain|oman|muscat|morocco|casablanca|rabat|tunisia|tunis|algeria|iraq|baghdad|lebanon|beirut)\b/],
  ['ru', /\b(russia|moscow|st\.? petersburg|kazakhstan|almaty|belarus|minsk)\b/],
  ['id', /\b(indonesia|jakarta|surabaya|bali)\b/]
];
var LANG_NAMES = { de:'German', es:'Spanish', fr:'French', it:'Italian', nl:'Dutch', pt:'Portuguese', pl:'Polish', tr:'Turkish', sv:'Swedish', da:'Danish', ja:'Japanese', ko:'Korean', zh:'Chinese', ar:'Arabic', ru:'Russian', hi:'Hindi', id:'Indonesian' };

function detectMarketLanguage(city) {
  var c = String(city || '').toLowerCase();
  if (!c || c === 'global' || c === 'worldwide') return 'en';
  for (var i = 0; i < MARKET_LANGS.length; i++) {
    if (MARKET_LANGS[i][1].test(c)) return MARKET_LANGS[i][0];
  }
  return 'en';
}

async function localizeQueries(queries, lang) {
  var langName = LANG_NAMES[lang];
  if (!langName) return null;
  var prompt = 'Translate these three buyer search queries into natural, native ' + langName
    + ' \u2014 phrased exactly as a local customer would type them to an AI assistant. Keep meaning and specificity. '
    + 'Respond ONLY with a JSON array of exactly 3 strings, no markdown.\n\n'
    + JSON.stringify(queries.map(function(q) { return q.query; }));
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 25000);
  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    var data = await res.json();
    var text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('').replace(/```json|```/g, '').trim();
    var arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== 3) return null;
    return arr.map(String);
  } catch (err) {
    clearTimeout(timer);
    console.warn('[simulation] query localization failed, using English:', err.message);
    return null;
  }
}

async function applyMarketLanguage(queries, city, forcedLang) {
  var lang = forcedLang || detectMarketLanguage(city);
  if (lang === 'en') return { queries: queries, language: 'en' };
  var localized = await localizeQueries(queries, lang);
  if (!localized) return { queries: queries, language: 'en' };
  var out = queries.map(function(q, i) {
    return { label: q.label, intent: q.intent,
      system: q.system + ' Answer in the same language as the question.',
      query: localized[i] };
  });
  return { queries: out, language: lang };
}

// Shared input normalization — one place for the category-cleaning rules.
function normalizeSimInput(input) {
  var name             = String(input.name             || '').trim();
  var category         = String(input.category         || '').trim();
  var city             = String(input.city             || '').trim();
  var inferredCategory = String(input.inferredCategory || category).trim();
  var description      = String(input.description      || '').trim();

  if (!name || !category) {
    throw new Error('Missing name or category');
  }

  var catClean = inferredCategory
    .replace(/^b2b\s+/i, '').replace(/^b2c\s+/i, '')
    .replace(/\s+vendor(s)?$/i, '').replace(/\s+provider(s)?$/i, '')
    .replace(/\s+platform(s)?$/i, ' platform').replace(/\s+direct-to-consumer$/i, '')
    .trim();

  return { name: name, category: category, city: city, catClean: catClean, description: description };
}

function beforeSummary(name, count) {
  return count === 0
    ? name + ' was not mentioned in any of the 3 queries. A buyer searching right now would not find you.'
    : count === 3
    ? name + ' was mentioned in all 3 queries. Current visibility is strong.'
    : name + ' was mentioned in ' + count + ' of 3 queries. Partial visibility \u2014 not consistent enough to rely on.';
}

function afterSummary(name, count) {
  return count === 3
    ? name + ' was mentioned in all 3 queries after positioning improvements. This is what AI says about you once the fixes are in place.'
    : count === 0
    ? name + ' was not mentioned after positioning improvements were applied. Trust signals are the critical remaining gap.'
    : name + ' was mentioned in ' + count + ' of 3 queries after positioning improvements were applied.';
}

// BEFORE half — needs only name/category/city/inferredCategory, so it can run
// BEFORE scoring. Its responses are the AI selection ground truth: the
// businesses AI actually recommends today, which drive competitor selection.
async function runBeforeSimulation(input) {
  var n = normalizeSimInput(input);
  var buyerQueries = await generateBuyerQueries(n, buildQueries(n.catClean, n.city, n.name));
  var loc = await applyMarketLanguage(buyerQueries, n.city, input.language);
  var results = await runQuerySet(loc.queries, n.name);
  var count = results.filter(function(r) { return r.appeared; }).length;
  return {
    name:     n.name,
    category: n.catClean,
    before: {
      language:      loc.language,
      results:       results,
      appearedCount: count,
      totalQueries:  3,
      summary:       beforeSummary(n.name, count)
    }
  };
}

// AFTER half — consumes the scored differentiator and trust signal, so it
// runs after scoring, exactly as before.
async function runAfterSimulation(input) {
  var n = normalizeSimInput(input);
  var differentiator = String(input.differentiator || '').trim();
  var trustSignal    = String(input.trustSignal    || '').trim();
  var locA = await applyMarketLanguage(
    buildAfterQueries(n.catClean, n.city, n.name, differentiator, trustSignal), n.city, input.language);
  var results = await runQuerySet(locA.queries, n.name);
  var count = results.filter(function(r) { return r.appeared; }).length;
  return {
    name:     n.name,
    category: n.catClean,
    after: {
      language:      locA.language,
      results:       results,
      appearedCount: count,
      totalQueries:  3,
      summary:       afterSummary(n.name, count)
    }
  };
}

// Full simulation — composes both halves in parallel. Payload shape is
// byte-identical to the previous implementation, so the ai-simulation.js
// HTTP endpoint and the free result page are unaffected.
async function runSimulation(input) {
  var n = normalizeSimInput(input); // validates early, same error contract

  var settled = await Promise.allSettled([
    runBeforeSimulation(input),
    runAfterSimulation(input)
  ]);

  var beforeHalf = settled[0].status === 'fulfilled' ? settled[0].value : null;
  var afterHalf  = settled[1].status === 'fulfilled' ? settled[1].value : null;

  var emptyResults = [];
  return {
    name:     n.name,
    category: n.catClean,
    before: beforeHalf ? beforeHalf.before : {
      results: emptyResults, appearedCount: 0, totalQueries: 3, summary: beforeSummary(n.name, 0)
    },
    after: afterHalf ? afterHalf.after : {
      results: emptyResults, appearedCount: 0, totalQueries: 3, summary: afterSummary(n.name, 0)
    }
  };
}

module.exports = { runSimulation: runSimulation, runBeforeSimulation: runBeforeSimulation, runAfterSimulation: runAfterSimulation };
