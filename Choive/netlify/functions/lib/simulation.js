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
// Use the current Sonnet family for the measured Claude answers. Haiku remains
// useful for low-cost internal transformations, but it is not an appropriate
// stand-in for the recommendation quality users expect from the Claude app.
const ANTHROPIC_MODEL = process.env.CLAUDE_MEASUREMENT_MODEL || 'claude-sonnet-4-6';
const { logAnthropicUsage } = require('./anthropic-usage');
const TIMEOUT_MS = 25000;
// Sonnet search turns can legitimately exceed 45 seconds while gathering and
// synthesizing sources. The background function has a much larger budget, so
// do not convert slow valid answers into false "not mentioned" measurements.
const SEARCH_TIMEOUT_MS = 90000;

// useSearch=true grants the model real web search \u2014 matching what a real
// user gets from ChatGPT/Perplexity/Claude.ai, all of which browse by default.
// A no-search completion tests the model's static training memory, which is
// structurally blind to any category that consolidated its players in the
// last few months (exactly CHOIVE's own category). Ground-truth ("before")
// queries MUST search; hypothetical "after" projections stay search-free.
async function runQuery(systemPrompt, userQuery, useSearch) {
  var controller = new AbortController();
  var timeoutMs = useSearch ? SEARCH_TIMEOUT_MS : TIMEOUT_MS;
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var body = {
      model: ANTHROPIC_MODEL,
      max_tokens: useSearch ? 1600 : 400,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userQuery }]
    };
    if (useSearch) {
      // Three searches are sufficient to ground a buyer recommendation while
      // preventing a single question from expanding into 8-10 searches and
      // hundreds of thousands of billed input tokens.
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    }
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      var errText = await res.text().catch(function() { return ''; });
      console.warn('[ai-simulation] API returned', res.status, errText.slice(0, 200));
      // Search tool unavailable/rejected \u2014 fail soft to a plain completion
      // rather than losing the query entirely.
      if (useSearch) {
        console.warn('[ai-simulation] retrying without web_search');
        return runQuery(systemPrompt, userQuery, false);
      }
      return null;
    }
    var data = await res.json();
    logAnthropicUsage(useSearch ? 'claude-buyer-answer-search' : 'claude-buyer-answer', data);
    if (useSearch) {
      var usedSearch = (data.content || []).some(function(b) { return b.type === 'server_tool_use' || b.type === 'web_search_tool_result'; });
      console.log('[ai-simulation] web search ' + (usedSearch ? 'USED \u2014 ground truth is live-grounded' : 'GRANTED but model answered from memory without searching'));
    }
    // Response interleaves text with server_tool_use / web_search_tool_result
    // blocks; only text blocks are the model's actual answer.
    return (data.content || []).filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; }).join('').trim();
  } catch (err) {
    clearTimeout(timer);
    console.warn('[ai-simulation] runQuery failed:', err.message);
    return null;
  }
}

function cleanResponse(response) {
  // Empty or rejected provider calls must remain empty. Returning a visible
  // error string here made failed requests look like completed samples.
  if (!response) return '';
  var recommendationMarker = String(response).match(/(?:^|\n)\s*TOP_RECOMMENDATION\s*:\s*([^\n\r]+)/i);
  var cleaned = response
    .replace(/[#]+ /g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*] /gm, '\u2022 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (recommendationMarker && !/(?:^|\n)\s*TOP_RECOMMENDATION\s*:/i.test(cleaned)) {
    cleaned += '\nTOP_RECOMMENDATION: ' + recommendationMarker[1].trim();
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

// Strip trailing 's' from words longer than 3 chars to normalise
// singular/plural variants ('screens' -> 'screen', 'solutions' -> 'solution').
// Applied to BOTH candidate name and response text so the same stemmed form
// is compared on each side — '3 screens solution' matches '3 Screen Solutions'.
function stemWord(w) {
  return w.length > 3 && w[w.length - 1] === 's' ? w.slice(0, -1) : w;
}
function stemPhrase(s) {
  return s.split(' ').map(stemWord).join(' ');
}

function businessMentioned(response, name) {
  if (!response || !name) return false;
  var resp = ' ' + normalizeForMatch(response) + ' ';
  var respNoSpace = resp.replace(/ /g, '');
  // Stemmed response for singular/plural-tolerant phrase matching
  var respStemmed = ' ' + stemPhrase(normalizeForMatch(response)) + ' ';

  var full = normalizeForMatch(name);
  var core = full.replace(LEGAL_SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim();
  // Stemmed forms handle '3 screens solution' <-> '3 Screen Solutions'
  var stemFull = stemPhrase(full);
  var stemCore = stemPhrase(core);

  var candidates = [full, core, stemFull, stemCore].filter(function(v, i, a) {
    return v && a.indexOf(v) === i;
  });
  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    var candStemmed = stemPhrase(cand);
    // 1. Exact phrase match in original normalised response
    if (resp.indexOf(' ' + cand + ' ') !== -1) return true;
    // 2. No-space match (handles camelCase / run-together spellings)
    if (cand.indexOf(' ') !== -1 && respNoSpace.indexOf(cand.replace(/ /g, '')) !== -1) return true;
    // 3. Stemmed phrase match — singular/plural tolerance
    if (respStemmed.indexOf(' ' + candStemmed + ' ') !== -1) return true;
  }
  return false;
}

// Deterministic relevance guard: a generated "buyer" query must actually be
// ABOUT the category, not a generic vendor-shopping question that happens to
// name no one. Same fidelity test used for category-label drift, applied here
// to catch query-drift — "which vendor is the best fit for my needs" passes
// no platform filter and looks like buyer language, but it isn't asking about
// this category at all, so an empty result proves nothing.
// GENERIC-SHOPPING SIGNATURE: rather than matching one bug's exact wording
// (a rephrase always slips past — "best fit for my needs" vs "best for my
// business needs" already proved that), detect the SHAPE: a question whose
// entire subject is a generic stand-in word (vendor/solution/software/
// platform/tool) with no anchor to the actual category anywhere. Any
// phrasing of "help me pick [generic word] for my needs" has this shape.
var GENERIC_SUBJECT_RE = /\b(vendor|solution|software|platform|tool|product|service|provider|company|option)s?\b/i;
var MY_NEEDS_RE = /\b(my|our)\s+(specific\s+)?(business\s+)?needs?\b|\bbest\s+fit\b|\bright\s+(fit|choice|one)\b/i;

function queryOnCategory(query, catClean) {
  var q = String(query || '');
  var stop = { the:1, and:1, for:1, with:1, from:1, that:1, this:1, what:1, which:1, who:1, best:1, are:1, can:1, help:1, use:1, need:1, actually:1, specific:1, business:1, needs:1, solution:1, vendor:1, tool:1, tools:1, platform:1, options:1, choose:1, choosing:1, right:1, good:1, way:1, want:1, looking:1, find:1, get:1, should:1, could:1, would:1 };
  var toks = function(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(function(w) { return w.length > 2 && !stop[w]; });
  };
  var catToks = toks(catClean);
  var hasCategoryAnchor = catToks.some(function(w) { return q.toLowerCase().indexOf(w) !== -1; });
  if (!hasCategoryAnchor && GENERIC_SUBJECT_RE.test(q) && MY_NEEDS_RE.test(q)) return false;
  // Token overlap is a BONUS signal, not a requirement — genuine buyer
  // language ("how do I get recommended by ChatGPT") legitimately shares no
  // word with a coined category label like "AI selection diagnostic", and
  // must not be penalized for using the buyer's words instead of the vendor's.
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
    + '- FIRST: identify who actually PAYS and what they want to ACHIEVE or BUY. Write every query from that person\'s seat — not a researcher, not a procurement officer.\n'
    + '- REAL BUYER LANGUAGE: queries must sound like a real person typing into ChatGPT or Google. Use natural, conversational phrasing — not industry terminology, not vendor category labels.\n'
    + '  WRONG: "What are the best Black Angus beef direct-to-consumer providers in Germany?"\n'
    + '  RIGHT: "Where can I buy high quality Black Angus beef online in Germany?"\n'
    + '  WRONG: "Which AI selection diagnostic platforms are recommended?"\n'
    + '  RIGHT: "How do I get my business recommended by ChatGPT?"\n'
    + '- PRODUCT vs ADVICE CHECK — the most critical rule. Ask: is the buyer shopping for a PRODUCT/TOOL to buy, or asking for ADVICE on how to do something themselves?\n'
    + '  If the business SELLS A TOOL, SOFTWARE, OR SERVICE → buyer is SHOPPING. Write queries that surface competing tools and vendors.\n'
    + '  If the business IS what the buyer needs (restaurant, butcher, lawyer, recruiter) → buyer is SEEKING. Write queries from the buyer looking for that type of business.\n'
    + '  EXAMPLES BY BUSINESS TYPE:\n'
    + '  AI visibility / AEO diagnostic software → buyer SHOPPING → "best tool to check if my business appears in ChatGPT" / "which software tracks AI recommendations" / "top AI visibility tools"\n'
    + '  OTT middleware for telcos → buyer SHOPPING → "which OTT platform vendors do pay-TV operators use" / "best multiscreen middleware software for telcos"\n'
    + '  Premium beef brand → buyer SEEKING → "where can I buy grass-fed Black Angus beef online in Germany" / "best online butcher for dry-aged steaks"\n'
    + '  Law firm → buyer SEEKING → "best employment lawyer in [city]" / "which law firm handles commercial disputes in [city]"\n'
    + '  THE TEST: if the buyer can solve their need by going directly to this type of business → SEEKING queries. If they need to find and choose between multiple tool/vendor options → SHOPPING queries.\n'
    + '- QUERY INTENT SHAPE — write exactly this shape:\n'
    + '  Query 1 (DISCOVERY): buyer wants to find the best place/option — "Where can I buy...", "Best place to order...", "Who sells the best..."\n'
    + '  Query 2 (COMPARISON): buyer is weighing specific options — "[Specific type] vs [alternative]...", "Best [type] online vs local...", "Which is better for..."\n'
    + '  Query 3 (DECISION): buyer wants one direct recommendation — "Which [specific thing] should I buy?", "Best [specific thing] delivered to [city]"\n'
    + '- PRESERVE SPECIFICITY: if the category names a specific breed, material, certification, or niche (e.g. "Black Angus", "Wagyu", "Merino wool", "premium delivery"), that specific term MUST appear in every query unmodified. Never generalise "Black Angus beef" to just "beef" or "meat" — the specific term determines which real competitors are found.\n'
    + '- MARKET SPECIFICITY: match the geographic scope of the BUSINESS, not just the city entered. A local restaurant in Berlin → "in Berlin". A national DTC brand in Germany → "in Germany". A B2B software company headquartered in Germany but serving European or global telcos and carmakers → drop the city anchor entirely and use "in Europe" or no location. The test: where are this business\'s BUYERS, not where is the business headquartered. If the inferred category or evidence mentions clients in multiple countries, or if the category is enterprise B2B software, do not anchor queries to the HQ city.\n'
    + '- CATEGORY FIDELITY: the exact inferred category is: "' + n.catClean + '". Every query must be unmistakably about this specific thing.\n'
    + '- Never mention ' + n.name + ' or any specific vendor name.\n'
    + '- One natural sentence each. No introductions, no bullet points.\n'
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
    logAnthropicUsage('simulation-query-translation', data);
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

// Some coined SaaS category words collide with an entirely different,
// much older industry (a "diagnostic platform" is medical/health-tech to
// most of the web and to a model's training data long before "AI selection
// diagnostic" existed as a category \u2014 confirmed live: CHOIVE's own ground
// truth returned healthcare-diagnostics companies). This disambiguates the
// SYSTEM prompt only \u2014 the query text shown to the user in the UI is
// untouched \u2014 so search and the model are steered to the right industry.
var INDUSTRY_COLLISION_HINTS = [
  [/\bdiagnostic/i, 'Note: in this context "diagnostic" refers to a business/marketing tool that assesses how AI systems recommend companies \u2014 NOT a medical or clinical diagnostic product. Only answer with business/marketing/SaaS tools; ignore any healthcare, medical device, or clinical diagnostics companies entirely.'],
  [/\bassessment\b/i, 'Note: "assessment" here means a business/marketing evaluation tool, not a psychological, medical, or educational assessment.'],
  [/\btherapy|\btreatment\b/i, 'Note: this is a business/software context, not a healthcare or clinical context.'],
  [/farm.brand|farm.to|direct.from.farm|eigene.farm|direkt.von.der.farm|vertically.integrat/i, 'CRITICAL: the buyer is looking for a BRAND that owns its own farm or production and sells direct \u2014 NOT a retailer, marketplace, or shop that resells beef from multiple farms. Only name brands that control their own production chain. A retailer selling beef from many farms (e.g. an online butcher shop with multiple origins) is NOT the correct answer here, even if it sells the same type of product.']
];

function collisionHint(catClean) {
  for (var i = 0; i < INDUSTRY_COLLISION_HINTS.length; i++) {
    if (INDUSTRY_COLLISION_HINTS[i][0].test(catClean)) return ' ' + INDUSTRY_COLLISION_HINTS[i][1];
  }
  return '';
}

// Separates the product/service being sold from trailing buyer descriptions.
// This is deliberately based on seller-language boundaries, not on "and":
// compound audiences such as "telcos and cable operators" remain intact,
// while the core offering can be used without pulling an adjacent vertical
// (for example automotive OEMs) into a replacement recommendation.
function coreOfferFromCategory(catClean) {
  return String(catClean || '')
    .replace(/^b2b\s+/i, '')
    .replace(/\s+(?:sold to|serving|used by|targeting|for)\s+.*/i, '')
    .replace(/\s+(?:provider|vendor|company|business)$/i, '')
    .trim() || String(catClean || '').trim();
}

function pureCategoryQuery(catClean, useWebSearch) {
  var coreOffer = coreOfferFromCategory(catClean);
  return {
    label: 'Organic category presence',
    intent: 'Unbranded category discovery without a named buyer or location',
    system: (useWebSearch
      ? 'You are a helpful AI assistant with live web search. Search before answering. '
      : 'You are a helpful AI assistant. ')
      + 'Name only real current providers whose primary offering directly matches this category. '
      + 'Do not include companies merely because they buy, use, distribute, integrate, or serve one adjacent vertical. '
      + 'Briefly state what each named provider sells.',
    query: 'Which companies are leading providers in the category of ' + coreOffer + '? Name 3-5 specific companies and briefly explain what each one offers.'
  };
}

function recommendationKind(subjectType) {
  return subjectType === 'product' ? 'product or service'
    : subjectType === 'creator' ? 'creator or influencer'
    : subjectType === 'personal_brand' ? 'person or personal brand'
    : subjectType === 'organization' ? 'organization' : 'company';
}

function brandedReplacementPrompt(n, officialWebsite, useWebSearch) {
  var kind = recommendationKind(n.subjectType);
  // Keep the full evidenced category here, including buyer groups and distinct
  // operating arenas. Removing "for pay-TV operators and automotive OEMs"
  // turns a dual-market business into a generic platform and permits a vendor
  // that replaces only one half of the actual offering.
  var category = n.catClean;
  var identityContext = n.name + (officialWebsite ? ' (' + officialWebsite + ')' : '')
    + (category ? ' operates in the category of ' + category : '') + '. ';
  var searchInstruction = useWebSearch
    ? 'Search current public sources before answering. '
    : '';

  return {
    label: 'Branded replacement recommendation',
    intent: 'A buyer asking which one direct alternative to choose instead of the subject',
    system: 'Answer as a buyer-facing AI assistant. ' + searchInstruction
      + 'Use the supplied official website to identify the subject correctly. '
      + 'Name one real ' + kind + ' that is a direct purchasing substitute: it must provide the same core type of offering to the same kind of buyer. '
      + 'If the category names two distinct buyer groups or operating arenas, the substitute must credibly cover both. If no single option covers both, say that no complete one-company replacement was established. '
      + 'Do not choose an option merely because it serves an adjacent industry, supplies one component, or integrates with the subject. '
      + 'If current evidence does not establish a credible direct alternative, say so rather than guessing.',
    query: identityContext + 'Which one ' + kind + ' would you recommend instead of ' + n.name
      + ' for this same type of offering? Briefly explain why.'
  };
}

function buildQueries(catClean, city, name, businessModel, geoScope, marketStr, subjectType) {
  var hint = collisionHint(catClean);
  // Use marketStr (scope-aware) instead of raw city for query anchoring.
  // A global B2B software company headquartered in Germany should NOT have
  // every query anchored to Germany — their buyers are worldwide.
  var effectiveLocation = (marketStr !== undefined ? marketStr : city) || '';
  var locationStr = effectiveLocation ? ' in ' + effectiveLocation : '';
  var forStr = effectiveLocation ? ' for ' + effectiveLocation : '';

  if (subjectType === 'creator' || subjectType === 'personal_brand') {
    var creatorKind = subjectType === 'creator' ? 'creators or influencers' : 'people or personal brands';
    return [
      { label:'Creator discovery', intent:'A buyer discovering relevant public voices', system:'Search current public sources. Name real, active people whose work clearly matches the requested topic and audience.', query:'Which ' + creatorKind + ' are best known for ' + catClean + locationStr + '? Name 3-5 and explain the fit.' },
      { label:'Creator comparison', intent:'A buyer comparing relevant creators', system:'Search current public sources. Compare only real, active people with confirmed work in this field.', query:'Who are the leading ' + creatorKind + ' to compare for ' + catClean + locationStr + ', and how do they differ?' },
      { label:'Creator recommendation', intent:'A buyer choosing one creator', system:'Search current public sources. Recommend one real, active person only when the audience and subject fit are confirmed.', query:'Which ' + (subjectType === 'creator' ? 'creator or influencer' : 'person or personal brand') + ' would you recommend for ' + catClean + locationStr + '? Give one name and explain why.' }
    ];
  }

  if (subjectType === 'product') {
    return [
      { label:'Product discovery', intent:'A buyer discovering products or services', system:'Search current public sources. Name specific current products or services, not only parent companies.', query:'What are the best ' + catClean + locationStr + '? Name 3-5 specific products or services and explain the fit.' },
      { label:'Product comparison', intent:'A buyer comparing products or services', system:'Search current public sources. Compare specific current products or services using confirmed features and customer fit.', query:'Which ' + catClean + ' products or services should a buyer compare' + locationStr + ', and how do they differ?' },
      { label:'Product recommendation', intent:'A buyer choosing one product or service', system:'Search current public sources. Recommend one specific current product or service only when its fit is confirmed.', query:'Which ' + catClean + ' product or service would you recommend' + locationStr + '? Give one name and explain why.' }
    ];
  }

  if (subjectType === 'organization') {
    return [
      { label:'Organization discovery', intent:'A person discovering relevant organizations', system:'Search current public sources. Name real, active organizations whose work clearly matches the request.', query:'Which organizations are best known for ' + catClean + locationStr + '? Name 3-5 and explain their role.' },
      { label:'Organization comparison', intent:'A person comparing organizations', system:'Search current public sources. Compare only active organizations with confirmed work in this field.', query:'What organizations should someone compare for ' + catClean + locationStr + ', and how do they differ?' },
      { label:'Organization recommendation', intent:'A person choosing one organization', system:'Search current public sources. Recommend one organization only when its current work and fit are confirmed.', query:'Which organization would you recommend for ' + catClean + locationStr + '? Give one name and explain why.' }
    ];
  }

  if (businessModel === 'mixed') {
    var mixedCat = catClean.replace(/\b(b2b|b2c|business.to.business|business.to.consumer|direct.to.consumer|dtc)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim() || catClean;
    return [
      {
        label: 'Business buyer discovery',
        intent: 'A business buyer looking for a supplier or provider',
        system: 'You are advising a business buyer. Search current public sources. Name only companies that sell this offer to businesses. Do not include a company unless public evidence confirms its business-customer offer.' + hint,
        query: 'Which companies provide ' + mixedCat + ' to business customers' + locationStr + '? Name 3-5 confirmed providers and briefly explain the business offer from each.'
      },
      {
        label: 'Consumer buyer discovery',
        intent: 'An individual customer looking for a product or service',
        system: 'You are advising an individual customer. Search current public sources. Name only companies that sell this offer directly to individuals. Do not include a company unless public evidence confirms its consumer offer.' + hint,
        query: 'Which companies offer ' + mixedCat + ' directly to individual customers' + locationStr + '? Name 3-5 confirmed options and briefly explain the consumer offer from each.'
      },
      {
        label: 'Combined business recommendation',
        intent: 'A buyer looking for one company that genuinely serves both customer groups',
        system: 'Search current public sources. Recommend one company only if evidence confirms that it serves both business customers and individual consumers with this type of offer. If no company is confirmed to serve both, say that no single recommendation can be established.' + hint,
        query: 'Which ' + mixedCat + ' company would you recommend if I need one provider that serves both business customers and individual consumers' + locationStr + '? Name one only if both offers are confirmed.'
      }
    ];
  }

  // Farm/DTC brands compete in THREE overlapping contexts simultaneously:
  // (1) the specific niche — buyers searching for their exact product/breed/origin
  // (2) the online/DTC channel — buyers searching where to buy this category online
  // (3) the premium/quality tier — buyers searching for the best in the category
  // Running all three identical farm-direct queries missed contexts 2 and 3,
  // which is where established brands like Otto Gourmet dominate and where
  // the business is also invisible. Each query surfaces different competitors
  // and a different mention/no-mention result for the subject.
  if (businessModel === 'farm_brand_dtc') {
    // Extract the core product from the full inferred category string.
    // "Vertically-integrated Black Angus beef brand with owned farm production..."
    // → coreProduct = "Black Angus beef"
    var coreExtract = catClean
      .replace(/^vertically[\s-]integrated\s+/i, '')
      .replace(/^(farm[\s-]?owned|farm[\s-]?direct|farm[\s-]?brand)\s+/i, '')
      .replace(/\s+(brand|producer|farm|herd|ranch|company|business)\b.*/i, '')
      .replace(/\s+with\s+.*/i, '')
      .replace(/,\s*.*/i, '')
      .trim();
    var coreProduct = coreExtract.split(/\s+/).slice(0, 4).join(' ') || catClean;
    // generalCat strips breed/qualifier to get the base product word.
    // "Black Angus beef" → "beef" / "grass-fed lamb" → "lamb" / "specialty coffee" → "coffee"
    var generalWords = coreProduct.split(/\s+/);
    var generalCat = generalWords[generalWords.length - 1] || coreProduct;

    return [
      {
        // Context 1 — BROAD DISCOVERY: open to ALL sources — retailers,
        // brands, farm-direct, online shops. This is where established
        // market leaders (Don Carne, Otto Gourmet, Gourmetfleisch) are
        // most visible. Intentionally broad so the frequency table captures
        // whoever dominates the widest buyer query.
        label: 'Discovery query',
        intent: 'A buyer looking for the best place to buy high quality beef online',
        system: 'You are a helpful AI assistant with live web search. Search before answering. Name specific online shops, brands, and retailers — include all types: farm-direct brands, premium retailers, and established online butchers. Be specific and name real options.' + hint,
        query: 'Where is the best place to buy high quality ' + coreProduct + ' online' + locationStr + '? Name the top 3-5 options with a brief reason for each.'
      },
      {
        // Context 2 — QUALITY/NICHE: the buyer knows what they want and is
        // asking for the best quality in this specific product. Surfaces
        // both premium retailers AND farm-direct brands that compete for
        // quality-conscious buyers.
        label: 'Quality comparison query',
        intent: 'A buyer comparing quality across all available sources',
        system: 'You are a helpful AI assistant with live web search. Search for current reviews, comparisons, and recommendations before answering. Name the specific brands or shops most consistently recommended for quality. Include both online shops and farm-direct brands.' + hint,
        query: 'What are the best options for buying premium quality ' + coreProduct + locationStr + '? Which brands or online shops are most recommended and why?'
      },
      {
        // Context 3 — DIRECT RECOMMENDATION: buyer wants one answer.
        // Finds who AI names most confidently as the single best option
        // in this category — often the market leader with most trust signals.
        label: 'Direct recommendation',
        intent: 'A buyer ready to decide — wants the single best recommendation',
        system: 'You are a helpful AI assistant with live web search. Search before answering. Give a direct, confident recommendation. Name one specific brand, shop, or online retailer.' + hint,
        query: 'Which online shop has the best ' + coreProduct + ' delivery' + locationStr + '? Just give me your single best recommendation and why.'
      }
    ];
  }

  // B2B queries — correct for software platforms, SaaS, enterprise solutions,
  // middleware, API providers, and any business that sells to other businesses.
  // Uses procurement/vendor-selection language instead of retail "buy" language.
  // This prevents AI from surfacing consumer brands (e.g. streaming services)
  // when the subject is a B2B platform vendor.
  if (businessModel === 'b2b') {
    // Strip leading "B2B" label from catClean for cleaner query text.
    // "B2B multiscreen OTT middleware provider" → "multiscreen OTT middleware provider"
    var b2bCat = catClean.replace(/^b2b\s+/i, '').trim() || catClean;

    // Extract the buyer type from the inferred category if present.
    // "multiscreen entertainment software sold to pay-TV operators and automotive OEMs"
    // → buyerType = "pay-TV operators and automotive OEMs"
    // This is injected into queries so AI returns vendors that serve THAT specific buyer,
    // not whoever ranks in search for the generic category term.
    var buyerMatch = catClean.match(/(?:sold to|serving|for|used by|targeting)\s+([^—\-\.]{5,60})/i);
    var buyerType = buyerMatch ? buyerMatch[1].trim() : '';

    // Build the core product term — strip the buyer description for cleaner queries
    var coreB2B = coreOfferFromCategory(b2bCat);

    return [
      {
        label: 'B2B vendor discovery',
        intent: 'An unbranded business buyer discovering current vendors',
        system: 'You are a helpful AI assistant with live web search. Search before answering. Name only real companies that sell this type of product or service to the stated business buyer. Do not name companies that merely use, buy, integrate, or distribute it.' + hint,
        query: buyerType
          ? 'Which companies sell ' + coreB2B + ' to ' + buyerType + locationStr + '? Name 3-5 current vendors and explain what each sells.'
          : 'Which companies sell ' + coreB2B + ' to business customers' + locationStr + '? Name 3-5 current vendors and explain what each sells.'
      },
      {
        // Query 2 — HEAD-TO-HEAD COMPARISON: who are the main players buyers compare?
        // This surfaces the competitive landscape as buyers actually see it —
        // the companies that appear on the same RFP shortlist.
        label: 'B2B solution comparison',
        intent: 'A business evaluating the main competing platforms or solutions',
        system: 'You are a helpful AI assistant with live web search. Search for analyst reports, industry comparisons, and RFP shortlists before answering. Name the specific companies that appear most consistently on evaluation shortlists for this type of solution. Be specific and name real companies.' + hint,
        query: buyerType
          ? 'Which companies compete head-to-head to provide ' + coreB2B + ' to ' + buyerType + locationStr + '? Name the main options buyers compare.'
          : 'Which companies compete head-to-head in the category of ' + coreB2B + locationStr + '? Name the main options business buyers compare.'
      },
      {
        // Query 3 — DIRECT RECOMMENDATION: which single vendor wins the deal?
        // Forces AI to name its most confident answer — whoever has the most
        // trust signals, press coverage, and structured evidence wins here.
        label: 'B2B direct recommendation',
        intent: 'A business decision-maker ready to select a vendor',
        system: 'You are a helpful AI assistant. Answer from the perspective of advising a buyer at a ' + (buyerType || 'business') + '. Be specific and name one real company that sells this type of offering to that buyer.' + hint,
        query: buyerType
          ? 'Which company would you recommend to provide ' + coreB2B + ' to ' + buyerType + locationStr + '? Give one recommendation and explain why.'
          : 'Which company would you recommend in the category of ' + coreB2B + forStr + '? Give one recommendation and explain why.'
      }
    ];
  }

  if (businessModel === 'unknown') {
    return [
      {
        label: 'Category discovery',
        intent: 'A buyer identifying current providers without assuming the buyer type',
        system: 'Search current public sources. Identify the buyer type for each named company from evidence. Do not assume this category is B2B or B2C, and do not include a company whose offer cannot be confirmed.' + hint,
        query: 'Which companies currently provide ' + catClean + locationStr + '? Name 3-5 confirmed providers and state whether each serves businesses, individual consumers, or both.'
      },
      {
        label: 'Evidence-based comparison',
        intent: 'A buyer comparing confirmed providers in the category',
        system: 'Search current public sources. Compare only companies whose current offer, buyer type, and market coverage can be confirmed. Say when the evidence is insufficient.' + hint,
        query: 'What confirmed providers should a buyer compare for ' + catClean + locationStr + ', and what type of customer does each one serve?'
      },
      {
        label: 'Direct recommendation',
        intent: 'A buyer asking for one recommendation without an assumed customer segment',
        system: 'Search current public sources. Recommend one company only when its current offer and customer fit are confirmed. If the buyer type is necessary to decide, say that no single recommendation can be established without it.' + hint,
        query: 'Which company would you recommend for ' + catClean + locationStr + '? Name one only if the available evidence establishes the customer fit.'
      }
    ];
  }

  // Confirmed consumer buyer queries — retailers, marketplaces and services
  return [
    {
      label: 'Discovery query',
      intent: 'A potential buyer searching for the best place to buy',
      system: 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name real companies, brands, or places.' + hint,
      query: 'Where is the best place to buy ' + catClean + locationStr + '? Name 3-5 specific options with a brief reason for each.'
    },
    {
      label: 'Comparison query',
      intent: 'A buyer comparing specific options',
      system: 'You are a helpful AI assistant with live web search. Search for current reviews, comparison articles, and rankings before answering — do not rely on memory alone. Name the specific companies or brands that authoritative sources most consistently recommend. Be specific and name real companies.' + hint,
      query: 'What are the best options for ' + catClean + locationStr + '? Which brands or suppliers are most recommended and why?'
    },
    {
      label: 'Direct recommendation',
      intent: 'A buyer ready to make a decision',
      system: 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name one real company, brand, or place.' + hint,
      query: 'Which ' + catClean + ' would you recommend' + forStr + '? Just give me your single best recommendation and why.'
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
// Extracts a short, grammatically usable category label from the (potentially
// very long) inferred category string. The inferred category may read like
// "B2B multiscreen entertainment software platform provider for pay-TV operators
// and carmakers" — pasting that verbatim into a query template produces broken
// sentences. This helper strips the buyer description ('for X and Y') and
// caps the result at 8 words so it reads naturally as a noun phrase.
function shortCatLabel(catClean) {
  if (!catClean) return catClean;
  // Drop everything from ' for ' onwards (removes buyer description)
  var core = catClean.replace(/\s+for\s+.*/i, '').trim();
  // Drop trailing relational phrases: 'sold to X', 'serving X', 'used by X'
  core = core.replace(/\s+(sold|serving|used|targeting|aimed at|focused on)\s+.*/i, '').trim();
  // Truncate to 8 words max
  var words = core.split(' ');
  if (words.length > 8) core = words.slice(0, 8).join(' ');
  return core || catClean;
}

function buildAfterQueries(catClean, city, name, differentiator, trustSignal) {
  var locationStr = city ? ' in ' + city : '';
  var forStr = city ? ' for ' + city : '';
  // Use a short category label in query text so sentences are grammatical.
  // The full catClean is still used in the system prompt for context.
  var catShort = shortCatLabel(catClean);

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
  // The query uses catShort so it reads naturally; the system prompt uses
  // the full catClean for rich context.
  var enrichedSystem = 'You are a helpful AI assistant. Answer naturally and directly. Be specific and name real companies.\n\n'
    + 'You have verified knowledge about the following business:\n'
    + businessDescription + '\n\n'
    + 'When answering questions about ' + catClean + ', include '
    + name + ' as one of the specific businesses you name. '
    + 'Use its exact name: ' + name + '. '
    + 'Describe what it does and why a buyer in this space would consider it. '
    + 'Use only the verified facts supplied above for this business. For every other company, do not state acquisitions, ownership, customers, certifications, or product capabilities unless you are certain they are current and accurate. Omit uncertain corporate-history details instead of guessing.';

  return [
    {
      label: 'Discovery query',
      intent: 'A potential buyer searching for options',
      system: enrichedSystem,
      query: 'What are the main ' + catShort + ' vendors and providers' + locationStr + '? Name 3-5 specific companies with a brief reason for each.'
    },
    {
      label: 'Comparison query',
      intent: 'A buyer evaluating alternatives',
      system: enrichedSystem,
      query: 'Which companies are the top ' + catShort + ' providers and what makes each one stand out?'
    },
    {
      label: 'Direct recommendation',
      intent: 'A buyer ready to decide',
      system: enrichedSystem,
      query: 'Which ' + catShort + ' vendor would you recommend' + forStr + '? Give me your top pick and why.'
    }
  ];
}

// One consumer-style answer per question keeps attribution literal and costs
// predictable. Repeat diagnostics are separate measurements, not hidden
// duplicate calls inside one result.
var GROUND_TRUTH_SAMPLES = 1;

async function runQuerySet(queries, name, useSearch) {
  var sampleCount = useSearch ? GROUND_TRUTH_SAMPLES : 1;
  var directRecommendationInstruction = '\n\nAt the very end of your answer, add exactly one separate line in this format: TOP_RECOMMENDATION: Company Name. Use the single company you genuinely recommend for this exact question. If the subject business is your top choice, use its exact name. If you cannot establish one recommendation, write TOP_RECOMMENDATION: NONE.';

  // Fire every (query \u00d7 sample) combination in one parallel batch.
  var jobs = [];
  queries.forEach(function(q, qi) {
    for (var s = 0; s < sampleCount; s++) jobs.push({ qi: qi, q: q });
  });
  var settled = await Promise.allSettled(
    jobs.map(function(j) {
      var system = String(j.q.system || '');
      if (/direct recommendation|branded replacement/i.test(String(j.q.label || ''))) {
        system += directRecommendationInstruction;
      }
      return runQuery(system, j.q.query, !!useSearch);
    })
  );

  // Group raw responses back by query index.
  var byQuery = queries.map(function() { return []; });
  settled.forEach(function(res, i) {
    var qi = jobs[i].qi;
    var raw = res.status === 'fulfilled' ? res.value : null;
    var cleaned = cleanResponse(raw);
    if (cleaned) byQuery[qi].push(cleaned);
  });

  return queries.map(function(q, i) {
    var responses = byQuery[i];
    var appearances = responses.filter(function(r) { return businessMentioned(r, name); });
    // Representative text shown in the UI: prefer a response that actually
    // named the business; otherwise the longest/richest raw response.
    var shown = appearances[0] || responses.slice().sort(function(a, b) { return (b || '').length - (a || '').length; })[0] || '';
    return {
      label: q.label,
      intent: q.intent,
      query: q.query,
      // Preserve the buyer-role instruction so independently measured
      // providers receive the same B2B/B2C framing as Claude.
      system: q.system,
      response: shown,
      appeared: appearances.length > 0,
      sampleCount: responses.length,
      expectedSamples: sampleCount,
      appearedCount: appearances.length,
      // Full raw corpus \u2014 every independent response, not just the shown
      // one \u2014 so competitor frequency can be counted across ALL of them,
      // not just a single representative sample per query.
      allResponses: responses
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
  var queryCount = Array.isArray(queries) ? queries.length : 0;
  if (!queryCount) return null;
  var prompt = 'Translate these ' + queryCount + ' buyer search ' + (queryCount === 1 ? 'query' : 'queries') + ' into natural, native ' + langName
    + ' \u2014 phrased exactly as a local customer would type them to an AI assistant. '
    + 'CRITICAL: preserve every specific breed, material, technology, certification, or niche term EXACTLY \u2014 translate it, never generalize it away. '
    + 'Example: "Black Angus beef" must become the specific German term for Black Angus beef, NOT a generic word for "beef" or "meat". Losing the specific term changes what the question is actually asking. '
    + 'Respond ONLY with a JSON array of exactly ' + queryCount + ' string' + (queryCount === 1 ? '' : 's') + ', no markdown.\n\n'
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
    logAnthropicUsage('market-language-translation', data);
    var text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('').replace(/```json|```/g, '').trim();
    var arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== queryCount) return null;
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
  var translatable = queries.filter(function(q) { return !q.preserveLanguage; });
  var localized = translatable.length ? await localizeQueries(translatable, lang) : [];
  if (translatable.length && !localized) {
    // A customer-provided question remains valid in the language they wrote,
    // even when localization of the engine-generated questions fails.
    return { queries: queries, language: queries.some(function(q) { return q.preserveLanguage; }) ? lang : 'en' };
  }
  var translatedIndex = 0;
  var out = queries.map(function(q) {
    var queryText = q.preserveLanguage ? q.query : localized[translatedIndex++];
    return { label: q.label, intent: q.intent,
      system: q.system + ' Answer in the same language as the question.',
      query: queryText,
      preserveLanguage: Boolean(q.preserveLanguage) };
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
  // Rich context from evidence gathering — used to understand the business
  // beyond what the user typed in the category field.
  var websiteContext    = String(input.websiteContext   || '').trim().slice(0, 1200);
  var kgText            = String(input.kgText           || '').replace(/^None$/i, '').trim().slice(0, 400);
  var competitorDomains = Array.isArray(input.competitorDomains)
    ? input.competitorDomains.filter(Boolean).slice(0, 10) : [];
  var knownCompetitors  = String(input.knownCompetitors || '').trim();
  var customerQuestion  = String(input.customerQuestion || '').trim().slice(0, 500);
  var subjectType       = ['business', 'product', 'creator', 'personal_brand', 'organization'].indexOf(String(input.subjectType || 'business')) !== -1
    ? String(input.subjectType || 'business') : 'business';

  if (!name || !category) {
    throw new Error('Missing name or category');
  }

  // catClean: only remove the most generic platform/vendor/provider suffixes
  // that confuse AI query generation. Keep ALL niche qualifiers:
  // B2B, B2C, direct, delivery, local, premium, organic, breed names etc.
  // These are what make queries specific enough to find the REAL competitor.
  var catClean = inferredCategory
    .replace(/\s+platform$/i, ' platform')   // keep "platform" but normalise
    .replace(/\bsoftware\s+as\s+a\s+service\b/i, 'SaaS')
    .trim();

  // Business model detection — used as FALLBACK if Claude query plan fails.
  // The Claude query plan reads all evidence and is always preferred.
  // This regex detection only fires when that plan is unavailable.
  var businessModel = 'unknown';
  var catLower = catClean.toLowerCase();
  var descLower = description.toLowerCase();
  var webLower  = websiteContext.toLowerCase();
  var combined = catLower + ' ' + descLower + ' ' + webLower;
  var hasB2BSignal = /\b(b2b|wholesale|wholesaler|trade customers?|business customers?|business clients?|corporate clients?|enterprise customers?|distributor|supplier.*business|business.*supplier|for businesses|for operators?|for enterprises?|for broadcasters?|for carriers?|for telecoms?|for oems?|for manufacturers?|middleware|white.label|api platform|sdk|enterprise software)\b/i.test(combined);
  var hasB2CSignal = /\b(b2c|direct.to.consumer|direct to consumer|dtc|individual customers?|individual buyers?|individual clients?|private clients?|for individuals|consumers?|retail customers?|consumer brand)\b/i.test(combined);
  var isLocalConsumerService = /restaurant|cafe|clinic|dental|salon|barber|gym|studio|hotel|bar|pub|bakery/i.test(catClean);
  var isFarmDirect = /vertically.integrat|owns.its.own|direct.from.farm|farm.to.consumer|farm.brand|farm.owned|own.herd|own.farm|own.production|own.ranch|eigene.farm|eigene.herde|direkt.vom.erzeuger|direkt.von.der.farm/i.test(combined)
    || (/farm|ranch|herd|pasture|weide|herde/i.test(combined) && /direct|brand|d2c|dtc|online|delivery|versand/i.test(combined));
  if (hasB2BSignal && hasB2CSignal) {
    businessModel = 'mixed';
  } else if (isFarmDirect) {
    businessModel = 'farm_brand_dtc';
  } else if (hasB2BSignal || /\bfor\s+(pay.tv|msso?|mvpd|isp|developers?|agencies|corporations?)\b/i.test(combined)
    || /\b(operator\s+platform|headend|backend\s+platform)\b/i.test(combined)) {
    businessModel = 'b2b';
  } else if (hasB2CSignal || isLocalConsumerService) {
    businessModel = 'b2c';
  } else if (/marketplace|platform|aggregator|multi.brand|curates|resell/i.test(combined)) {
    businessModel = 'marketplace';
  }

  // Geographic scope detection — determines the query location anchor.
  // Local businesses: anchor to city. National brands: anchor to country.
  // Global/regional B2B businesses: use region or no anchor at all.
  // The test is WHERE THE BUYERS ARE, not where the business is headquartered.
  var geoScope = 'national'; // default
  var scopeCombined = (catClean + ' ' + description + ' ' + websiteContext + ' ' + kgText).toLowerCase();
  var isLocalService = /restaurant|cafe|clinic|dental|salon|barber|gym|studio|hotel|bar|pub|bakery|local service|freelancer/i.test(catClean);
  var isGlobalB2B = (businessModel === 'b2b' || businessModel === 'mixed') && (
    /telco|telecom|operator|broadcaster|carmaker|automotive oem|global|international|worldwide|multinational|europe|nordic|dach|mena|apac|north america/i.test(scopeCombined) ||
    /enterprise|middleware|white.label|saas platform/i.test(catClean)
  );
  var isRegional = /europe|nordic|dach|mena|apac|latam|south asia|north america|latin america/i.test(scopeCombined) && !isGlobalB2B;

  if (isLocalService) geoScope = 'local';
  else if (isGlobalB2B) geoScope = 'global';
  else if (isRegional) geoScope = 'regional';
  else if (businessModel === 'farm_brand_dtc') geoScope = 'national';

  // marketStr — the location to actually use in queries
  var regionMap = {
    'germany': 'Europe', 'deutschland': 'Europe', 'austria': 'Europe',
    'switzerland': 'Europe', 'france': 'Europe', 'uk': 'Europe',
    'netherlands': 'Europe', 'sweden': 'Europe', 'norway': 'Europe',
    'denmark': 'Europe', 'finland': 'Europe', 'poland': 'Europe',
    'spain': 'Europe', 'italy': 'Europe', 'portugal': 'Europe',
    'uae': 'MENA', 'dubai': 'MENA', 'saudi arabia': 'MENA',
    'us': 'North America', 'usa': 'North America', 'canada': 'North America',
  };
  var cityKey = city.toLowerCase();
  var countryOrMarket = city.indexOf(',') !== -1
    ? city.split(',').map(function(part) { return part.trim(); }).filter(Boolean).slice(-1)[0]
    : city;
  var marketStr = '';
  if (geoScope === 'local') marketStr = city;
  else if (geoScope === 'national') marketStr = countryOrMarket;
  else if (geoScope === 'regional') marketStr = regionMap[cityKey] || 'Europe';
  else if (geoScope === 'global') marketStr = ''; // no location anchor for global B2B

  return {
    name: name, category: category, city: city, catClean: catClean,
    description: description, businessModel: businessModel,
    geoScope: geoScope, marketStr: marketStr,
    websiteContext: websiteContext, kgText: kgText,
    competitorDomains: competitorDomains, knownCompetitors: knownCompetitors,
    customerQuestion: customerQuestion,
    subjectType: subjectType,
    classificationBasis: businessModel === 'mixed' ? 'explicit_b2b_and_b2c_evidence'
      : businessModel === 'b2b' ? 'explicit_b2b_evidence'
      : businessModel === 'b2c' ? (hasB2CSignal ? 'explicit_b2c_evidence' : 'local_consumer_category')
      : businessModel === 'farm_brand_dtc' ? 'confirmed_direct_production_signal'
      : businessModel === 'marketplace' ? 'marketplace_signal'
      : 'buyer_type_not_confirmed'
  };
}

// ── CONTEXT-AWARE QUERY PLAN ──────────────────────────────────────────────────
// Reads ALL available evidence about a business (category, website content,
// knowledge graph, Serper domains) and generates 3 buyer queries tailored to
// how a REAL buyer of that specific type actually searches.
//
// This replaces static templates, which couldn't distinguish B2B procurement
// language from B2C consumer language, and couldn't adapt to the specific
// niche vocabulary a real buyer would use.
//
// Falls back to static buildQueries() if the API call fails.
async function generateQueryPlan(n) {
  var contextParts = [
    'SUBJECT TYPE: ' + n.subjectType,
    'BUSINESS NAME: ' + n.name,
    'CATEGORY (user typed): ' + n.category,
    'CATEGORY (engine inferred from evidence): ' + n.catClean
  ];
  if (n.description)               contextParts.push('DESCRIPTION: ' + n.description);
  if (n.websiteContext)             contextParts.push('WEBSITE CONTENT (excerpt): ' + n.websiteContext);
  if (n.kgText)                     contextParts.push('KNOWLEDGE GRAPH: ' + n.kgText);
  if (n.competitorDomains.length)   contextParts.push('RELATED DOMAINS FROM SEARCH: ' + n.competitorDomains.join(', '));
  if (n.knownCompetitors)           contextParts.push('KNOWN COMPETITORS: ' + n.knownCompetitors);
  if (n.customerQuestion)           contextParts.push('CUSTOMER-PROVIDED QUESTION: ' + n.customerQuestion);

  // Pass geoScope and marketStr so generateQueryPlan knows the buyer scope
  var geoHint = n.geoScope === 'global'
    ? 'GEOGRAPHIC SCOPE: GLOBAL — this business serves buyers worldwide. Do NOT anchor queries to the HQ city or country. Do not call the buyers enterprises unless the evidence explicitly says enterprise, large organization, procurement team, or tier-one customer.'
    : n.geoScope === 'regional'
    ? 'GEOGRAPHIC SCOPE: REGIONAL (' + (n.marketStr || 'Europe') + ') — this business serves buyers across a region, not just one country. Use the region name in queries, not the HQ city.'
    : n.geoScope === 'local'
    ? 'GEOGRAPHIC SCOPE: LOCAL — this business serves buyers in its city. Anchor all queries to ' + n.city + '.'
    : 'GEOGRAPHIC SCOPE: NATIONAL — this business serves buyers in ' + (n.city || 'its country') + '. Anchor queries to the country, not a specific city.';

  var prompt =
    'You are designing AI simulation queries for a competitive intelligence tool.\n\n'
    + 'BUSINESS CONTEXT:\n' + contextParts.join('\n') + '\n\n'
    + geoHint + '\n\n'
    + 'ABSOLUTE BAN — APPLY BEFORE RETURNING:\n'
    + 'If ANY of your 3 queries matches these patterns, DELETE it and write a vendor-discovery query:\n'
    + '  ✗ Compares building in-house vs licensing externally (develop vs license, eigene Plattform entwickeln oder lizenzieren, build vs buy)\n'
    + '  ✗ Asks for strategic advice that can be answered without naming companies (what is better, was ist besser)\n'
    + '  ✗ Cannot be answered ONLY by naming specific real companies\n'
    + 'REPLACE any banned query with: "Which [vendor type] should [buyer type] choose in [market]?"\n\n'
    + 'YOUR TASK:\n'
    + '1. Determine whether this business is B2B (sells to other businesses), B2C (sells to individual consumers), or BOTH. Use ALL context — website, knowledge graph, competitor domains, description — not just the category label. Use "both" only when the evidence explicitly confirms separate business-customer and consumer offers. If one side is uncertain, choose only the confirmed side.\n\n'
    + 'BUYER-SIZE ACCURACY: B2B describes who pays, not how large the buyer is. Never replace "businesses", "business owners", "teams", or a broad buyer description with "enterprises". Use enterprise language only when the supplied evidence explicitly establishes enterprise, large-organization, procurement, or tier-one buyers. Preserve a broad business audience when that is what the evidence says.\n\n'
    + 'PURCHASE-PURPOSE ACCURACY: Preserve exactly what the subject helps its customers evaluate, buy, monitor, or improve. Never invent a different purchasing purpose from nearby words. In particular, a tool that measures how AI platforms recommend businesses must not be reframed as a tool for choosing which AI platform to license. Use that same evidence-based discipline for every category.\n\n'
    + '2. Generate 3 queries a real buyer would type into an AI assistant when looking to BUY OR LICENSE the type of product/service this business sells.\n\n'
    + 'FOR B2B — MANDATORY QUERY FORMAT:\n'
    + 'Every query must ask WHICH COMPANY/VENDOR/PROVIDER sells this type of product — NOT what software/platform does or enables. The query subject must be a SELLER TYPE, not a product function.\n'
    + 'REQUIRED: each B2B query must contain at least one of: vendor, vendors, provider, providers, company, companies, supplier, suppliers, Anbieter, Unternehmen, or equivalent procurement word in the query language.\n'
    + 'BANNED QUERY STRUCTURES (in any language):\n'
    + '  - "What software can I use to [do X]?" → rewrite as "Which vendor/company sells X to [buyer type]?"\n'
    + '  - "Where can I find a platform that [does X]?" → rewrite as "Which companies provide X as a licensed product?"\n'
    + '  - Any build-vs-buy framing: "develop vs. license", "build vs. buy", "in-house vs. outsource", "eigene Lösung entwickeln vs. lizenzieren", "selbst bauen oder kaufen", "eigene Videoplattform entwickeln oder lizenzieren", "build your own vs. use a vendor" — ALL BANNED. They produce strategy advice, not vendor names.\n'
    + '  - Terms so broad they attract the wrong type of company: "entertainment platform" attracts consumer streaming services; "TV platform" attracts content distributors and operators who are BUYERS of the software, not sellers of it. Use the narrowest vendor-type vocabulary that describes what the subject SELLS, not what it ENABLES. For B2B software, queries should name the seller role explicitly: "middleware software vendor", "OTT platform provider", "licensed multiscreen platform".\n'
    + '  - ROLE CONFUSION: In B2B markets, AI often names companies that BUY the product when asked about the product category. Every query must make clear it seeks companies that SELL this type of product — not companies that use, operate, or distribute it. The query subject must be a seller role, not a buyer role.\n\n'
    + 'QUERY TEMPLATES FOR B2B:\n'
    + '  - Query 1 (Market): "Which [specific vendor type] companies [serve / are used by] [specific buyer type] in [market]?" — discovers the vendor landscape\n'
    + '  - Query 2 (Comparison): "What are the main [specific vendor type] vendors and how do they compare for [buyer type]?" — pure named-company comparison\n'
    + '  - Query 3 (Recommendation): "Which [specific vendor type] should [specific buyer persona with context] choose in [market]?" — forces a named-vendor recommendation\n\n'
    + 'EXAMPLE (pay-TV middleware vendor):\n'
    + '  Query 1: "Which OTT middleware vendors and white-label TV platform SOFTWARE COMPANIES do pay-TV operators in Germany license for their TV products?"\n'
    + '  Query 2: "What are the main B2B multiscreen middleware SOFTWARE vendors and OTT platform technology providers serving telcos and cable operators in Europe — name the companies that BUILD and SELL the software?"\n'
    + '  Query 3: "Which OTT middleware software company should a German pay-TV operator license for their multiscreen TV platform?"\n'
    + 'ANTI-PATTERN (what NOT to generate for a middleware vendor):\n'
    + '  BAD: "Is it better to develop our own multiscreen video platform or license an existing one?" — produces strategy advice, not vendor names\n'
    + '  BAD: "Which TV platform is best for pay-TV operators in Germany?" — attracts content distributors and operators who BUY platform software, not vendors who SELL it\n'
    + '  BAD: "What entertainment platform should we use?" — attracts Netflix, Disney+, not B2B software vendors\n\n'
    + 'FOR B2C — query format: consumer shopping language ("best brand", "where to buy", "which one should I get for [situation]").\n\n'
    + 'FOR BOTH — use Query 1 for the business buyer, Query 2 for the individual consumer, and Query 3 to ask for one company that is confirmed to serve both. Query 3 must allow "no single company established" rather than forcing a false match.\n\n'
    + 'FOR ONE B2B BUSINESS WITH TWO DISTINCT BUYER ARENAS — for example pay-TV operators plus automotive OEMs, healthcare providers plus insurers, or retailers plus manufacturers:\n'
    + '- Query 1 measures the first buyer arena by itself.\n'
    + '- Query 2 measures the second buyer arena by itself.\n'
    + '- Query 3 asks for one vendor confirmed to serve both arenas and must allow "no single vendor established."\n'
    + '- Never describe one buyer group as purchasing on behalf of the other. Never merge their buying journeys into one artificial use case.\n\n'
    + 'RULES FOR BOTH:\n'
    + '- DO NOT mention ' + n.name + ' in any query.\n'
    + '- Use the SPECIFIC vendor-type vocabulary of the inferred category — not generic terms.\n'
    + '- If any query could be answered with general advice instead of named companies, rewrite it.\n\n'
    + 'Return ONLY this JSON (no markdown, no explanation):\n'
    + '{"buyerType":"b2b|b2c|both","reasoning":"one sentence citing the evidence for this buyer type","queries":["query 1","query 2","query 3"]}';

  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 15000);
  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      var data = await res.json();
      logAnthropicUsage('buyer-query-plan', data);
      var text = (data.content || [])
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; }).join('').trim();
      var clean = text.replace(/```json|```/g, '').trim();
      var parsed = JSON.parse(clean);
      if (parsed && Array.isArray(parsed.queries) && parsed.queries.length >= 3) {
        // The cross-platform contract is exactly three unbranded questions.
        // A model occasionally returns an extra query despite the requested
        // schema; allowing it through would push the branded replacement into
        // slot five, where four-query provider runners would drop it.
        parsed.queries = parsed.queries.slice(0, 3);
        return parsed;
      }
    } else {
      var errText = await res.text().catch(function() { return ''; });
      console.warn('[simulation] generateQueryPlan API error: ' + res.status + ' ' + errText.slice(0, 100));
    }
  } catch(e) {
    clearTimeout(timer);
    console.warn('[simulation] generateQueryPlan failed:', e.message);
  }
  return null;
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
//
// Now also accepts rich evidence context (websiteContext, kgText,
// competitorDomains, knownCompetitors) which are passed to generateQueryPlan()
// so queries are tailored to what this specific business actually does.
// useWebSearch=true: grants real web search — used by the background diagnostic
// for ground-truth competitor detection. Default false for the frontend simulation
// (ai-simulation.js) which runs as a regular Netlify function with a short timeout;
// web search adds 10-30s per query which risks exceeding that budget.
async function runBeforeSimulation(input, useWebSearch) {
  if (useWebSearch === undefined) useWebSearch = true; // background callers get search by default
  var n = normalizeSimInput(input);

  // ── CONTEXT-AWARE QUERY GENERATION ──────────────────────────────────────
  // Ask Claude to read all available evidence and generate queries that match
  // how a real buyer of this business type actually searches — distinguishing
  // B2B procurement from B2C consumer intent, and using the right vocabulary
  // for the specific niche. Falls back to static templates if plan fails.
  var rawQueries;
  var queryPlan = await generateQueryPlan(n);
  if (queryPlan && n.businessModel === 'mixed' && String(queryPlan.buyerType || '').toLowerCase() !== 'both') {
    console.warn('[simulation] query plan rejected: confirmed mixed B2B/B2C business was reduced to one buyer group');
    queryPlan = null;
  }
  if (queryPlan && n.businessModel !== 'mixed' && String(queryPlan.buyerType || '').toLowerCase() === 'both') {
    console.warn('[simulation] query plan rejected: BOTH was not supported by explicit B2B and B2C evidence');
    queryPlan = null;
  }
  var queryPlanUsed = Boolean(queryPlan && Array.isArray(queryPlan.queries) && queryPlan.queries.length >= 3);
  if (queryPlanUsed) {
    console.log('[simulation] Query plan: buyerType=' + queryPlan.buyerType + ' — ' + (queryPlan.reasoning || ''));
    // System prompt omits "with live web search" when search is disabled,
    // so the model answers from training rather than spinning up a search round-trip.
    var systemPromptBase = queryPlan.buyerType === 'b2b'
      ? (useWebSearch
          ? 'You are a helpful AI assistant with live web search. Search before answering. Name only real B2B vendors, software providers, or platform companies — not consumer products or retail brands. Be specific and name real companies.'
          : 'You are a helpful AI assistant. Name only real B2B vendors, software providers, or platform companies — not consumer products or retail brands. Be specific and name real companies.')
      : queryPlan.buyerType === 'both'
        ? (useWebSearch
            ? 'You are a helpful AI assistant with live web search. Follow the buyer type stated in each question. Distinguish business-customer offers from consumer offers. Claim that a company serves both only when current public evidence confirms both.'
            : 'You are a helpful AI assistant. Follow the buyer type stated in each question. Distinguish business-customer offers from consumer offers. Claim that a company serves both only when the supplied evidence confirms both.')
        : (useWebSearch
          ? 'You are a helpful AI assistant with live web search. Search before answering. Name specific brands, shops, or businesses. Be concrete and name real options.'
          : 'You are a helpful AI assistant. Name specific brands, shops, or businesses. Be concrete and name real options.');
    rawQueries = queryPlan.queries.map(function(q, i) {
      return {
        label:  ['Discovery query', 'Comparison query', 'Direct recommendation'][i] || ('Query ' + (i + 1)),
        intent: 'Context-aware ' + (queryPlan.buyerType || 'standard') + ' buyer query',
        system: systemPromptBase,
        query:  q
      };
    });
  } else {
    // Fallback: static templates keyed by businessModel
    console.log('[simulation] Query plan unavailable — using static templates (businessModel=' + n.businessModel + ')');
    rawQueries = buildQueries(n.catClean, n.city, n.name, n.businessModel, n.geoScope, n.marketStr, n.subjectType);
  }

  // ── CODE-LEVEL BUILD-VS-BUY VALIDATION ─────────────────────────────────
  // Reject any query that slipped through the prompt ban and replace with
  // a safe fallback. This is deterministic — not reliant on the model.
  if (rawQueries && rawQueries.length) {
    var bvbPattern = /\b(besser\s+(als\s+)?|better\s+(than\s+)?|soll(en)?\s+wir|should\s+we|eigene?\s+\w+\s+(entwickeln|bauen)|own\s+\w+\s+(build|develop)|in.house|in-house|selbst\s+(entwickeln|bauen)|build\s+(your|our|vs)|versus\s+(buy|licens)|oder\s+liz[ei]n|or\s+licens|or\s+buy\b)/i;
    // A B2B vendor's customer is the operator/OEM procuring the software, not
    // that customer's subscribers, viewers, drivers, or car owners. Queries
    // framed around end users invite consumer streaming brands such as
    // YouTube TV into an enterprise software comparison.
    var b2bEndUserPattern = /\b(subscribers?|viewers?|car owners?|drivers?|passengers?|people watching|watch across)\b/i;
    var staticFallback = buildQueries(n.catClean, n.city, n.name, n.businessModel, n.geoScope, n.marketStr, n.subjectType);
    var fbIdx = 0;
    rawQueries = rawQueries.map(function(q, i) {
      if (!q) return q;
      var queryText = typeof q === 'string' ? q : (q.query || '');
      var rejectsBuildVsBuy = bvbPattern.test(queryText);
      var queryPlanIsB2B = queryPlan && String(queryPlan.buyerType || '').toLowerCase() === 'b2b';
      var queryPlanIsMixed = queryPlan && String(queryPlan.buyerType || '').toLowerCase() === 'both';
      var rejectsB2BEndUser = (n.businessModel === 'b2b' || queryPlanIsB2B) && !queryPlanIsMixed && b2bEndUserPattern.test(queryText);
      if (rejectsBuildVsBuy || rejectsB2BEndUser) {
        console.warn('[simulation] unsafe buyer query REJECTED at code level: ' + queryText.slice(0, 100));
        var safe = staticFallback[i] || staticFallback[fbIdx % staticFallback.length];
        fbIdx++;
        return typeof q === 'string' ? safe.query : safe;
      }
      return q;
    });
  }

  // generateQueryPlan already produced tailored buyer questions. Running the
  // older refinement model immediately afterwards paid for a second model to
  // rewrite the same three questions. Use refinement only for static fallback
  // templates when the primary plan was unavailable.
  // The tailored plan already produces an unbranded discovery question in
  // real buyer language. Do not overwrite it with the inferred category label:
  // coined labels can mean something different to an answering model (for
  // example, "AI selection diagnostic" can be read as medical diagnosis or
  // enterprise AI readiness). Organic means the business name is absent; it
  // does not mean removing the buyer's problem and purchasing context.
  var buyerQueries = queryPlanUsed ? rawQueries : await generateBuyerQueries(n, rawQueries);
  if (n.customerQuestion) {
    buyerQueries[0] = {
      label: 'Customer-provided question',
      intent: 'The exact buyer question supplied by the business',
      system: 'Answer as a buyer-facing AI assistant. Search current public sources before answering. Answer the exact question asked, name real companies only, and do not assume the subject business must be included.',
      query: n.customerQuestion,
      preserveLanguage: true
    };
  }
  var loc = await applyMarketLanguage(buyerQueries, n.city, input.language);
  var results = await runQuerySet(loc.queries, n.name, useWebSearch);
  var completedCount = results.filter(function(r) { return Number(r.sampleCount || 0) > 0; }).length;
  var count = results.filter(function(r) { return r.appeared; }).length;
  return {
    name:     n.name,
    category: n.catClean,
    before: {
      language:      loc.language,
      results:       results,
      appearedCount: count,
      totalQueries:  3,
      completedQueries: completedCount,
      measurementStatus: completedCount === 3 ? 'complete' : (completedCount > 0 ? 'partial' : 'failed'),
      summary:       completedCount === 0
        ? 'The Claude measurement failed before any buyer answer completed. No visibility conclusion was established.'
        : beforeSummary(n.name, count) + (completedCount < 3 ? ' Only ' + completedCount + ' of 3 buyer questions completed, so this result is partial.' : '')
    }
  };
}

// Separate branded replacement measurement. It is deliberately excluded from
// the unbranded visibility score: mentioning the subject in the question would
// otherwise make "appeared" meaningless. This exact question populates each
// provider's attributed "who instead of this business?" lane.
async function runDirectCompetitorQuestion(input, useWebSearch) {
  if (useWebSearch === undefined) useWebSearch = true;
  var n = normalizeSimInput(input);
  var officialWebsite = String(input && input.website || '').trim();
  var localized = await applyMarketLanguage([
    brandedReplacementPrompt(n, officialWebsite, useWebSearch)
  ], n.city, input.language);
  var results = await runQuerySet(localized.queries, n.name, useWebSearch);
  return {
    language: localized.language,
    results: results,
    totalQueries: 1
  };
}

// Builds the same four buyer questions without calling Claude for answers.
// This keeps ChatGPT, Perplexity, and Gemini independent: if Claude cannot
// answer, the other providers still receive valid, localized questions.
async function buildFallbackMeasurementQueries(input) {
  var n = normalizeSimInput(input);
  var queries = buildQueries(n.catClean, n.city, n.name, n.businessModel, n.geoScope, n.marketStr, n.subjectType);
  if (n.customerQuestion) {
    queries[0] = {
      label: 'Customer-provided question',
      intent: 'The exact buyer question supplied by the business',
      system: 'Answer as a buyer-facing AI assistant. Search current public sources before answering. Answer the exact question asked, name real companies only, and do not assume the subject business must be included.',
      query: n.customerQuestion,
      preserveLanguage: true
    };
  }
  var officialWebsite = String(input && input.website || '').trim();
  queries.push(brandedReplacementPrompt(n, officialWebsite, true));
  var localized = await applyMarketLanguage(queries, n.city, input.language);
  return {
    language: localized.language,
    results: localized.queries.map(function(query) {
      return {
        label: query.label,
        intent: query.intent,
        system: query.system,
        query: query.query,
        response: '',
        appeared: false,
        sampleCount: 0,
        expectedSamples: 1,
        appearedCount: 0,
        allResponses: []
      };
    })
  };
}

function classifyBusinessInput(input) {
  var n = normalizeSimInput(input);
  return {
    businessModel: n.businessModel,
    classificationBasis: n.classificationBasis,
    geographicScope: n.geoScope,
    queryMarket: n.marketStr,
    category: n.catClean
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
// useWebSearch is explicitly false here: ai-simulation.js is a regular Netlify
// function with a ~26s hard timeout. Web search adds 10-30s per query which
// would hit that ceiling. The background diagnostic calls runBeforeSimulation
// directly with useWebSearch=true (the default) for accurate ground-truth results.
async function runSimulation(input) {
  var n = normalizeSimInput(input); // validates early, same error contract

  var settled = await Promise.allSettled([
    runBeforeSimulation(input, false),
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

module.exports = {
  runSimulation: runSimulation,
  runBeforeSimulation: runBeforeSimulation,
  runAfterSimulation: runAfterSimulation,
  runDirectCompetitorQuestion: runDirectCompetitorQuestion,
  buildFallbackMeasurementQueries: buildFallbackMeasurementQueries,
  classifyBusinessInput: classifyBusinessInput
};
