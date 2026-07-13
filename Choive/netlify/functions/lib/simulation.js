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
const SEARCH_TIMEOUT_MS = 45000; // web search round-trips take longer

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
      max_tokens: useSearch ? 900 : 400,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userQuery }]
    };
    if (useSearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
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
    + '- FIRST: identify who actually PAYS and what they want to ACHIEVE or BUY. Write every query from that person\'s seat — not a researcher, not a procurement officer.\n'
    + '- REAL BUYER LANGUAGE: queries must sound like a real person typing into ChatGPT or Google. Use natural, conversational phrasing — not industry terminology, not vendor category labels.\n'
    + '  WRONG: "What are the best Black Angus beef direct-to-consumer providers in Germany?"\n'
    + '  RIGHT: "Where can I buy high quality Black Angus beef online in Germany?"\n'
    + '  WRONG: "Which AI selection diagnostic platforms are recommended?"\n'
    + '  RIGHT: "How do I get my business recommended by ChatGPT?"\n'
    + '- DIRECTION CHECK: if the offering helps businesses get discovered or recommended (a marketing tool), the buyer is a business OWNER asking how to make their OWN business get recommended — NOT someone shopping for software. Do not invert the transaction.\n'
    + '- QUERY INTENT SHAPE — write exactly this shape:\n'
    + '  Query 1 (DISCOVERY): buyer wants to find the best place/option — "Where can I buy...", "Best place to order...", "Who sells the best..."\n'
    + '  Query 2 (COMPARISON): buyer is weighing specific options — "[Specific type] vs [alternative]...", "Best [type] online vs local...", "Which is better for..."\n'
    + '  Query 3 (DECISION): buyer wants one direct recommendation — "Which [specific thing] should I buy?", "Best [specific thing] delivered to [city]"\n'
    + '- PRESERVE SPECIFICITY: if the category names a specific breed, material, certification, or niche (e.g. "Black Angus", "Wagyu", "Merino wool", "premium delivery"), that specific term MUST appear in every query unmodified. Never generalise "Black Angus beef" to just "beef" or "meat" — the specific term determines which real competitors are found.\n'
    + '- MARKET SPECIFICITY: if a city or country is provided, EVERY query must be geographically anchored. A buyer in Germany asks "...in Germany" or "...delivered to Germany" — never a global question.\n'
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

function buildQueries(catClean, city, name, businessModel) {
  var hint = collisionHint(catClean);
  var locationStr = city ? ' in ' + city : '';
  var forStr = city ? ' for ' + city : '';

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
        // Context 1 — SPECIFIC NICHE: finds who AI recommends in the exact
        // product niche. Uses the full coreProduct term and the farm-ownership
        // hint so only same-model brands (not retailers) are named.
        label: 'Niche brand query',
        intent: 'A buyer looking for a specific type of farm-owned brand that sells direct',
        system: 'You are a helpful AI assistant with live web search. Search before answering. Name only brands that own their own production and sell directly to consumers — not retailers that resell from multiple farms. Be specific and name real brands.' + hint,
        query: 'What are the best ' + coreProduct + ' brands' + locationStr + '? Which ones produce their own product and sell directly to customers online?'
      },
      {
        // Context 2 — ONLINE/DTC CHANNEL: open to ALL online sources in the
        // general category. This is where established DTC brands and premium
        // online shops appear — including competitors the niche query misses.
        label: 'Online channel query',
        intent: 'A buyer searching for the best place to buy this product category online',
        system: 'You are a helpful AI assistant with live web search. Search for current recommendations before answering. Name specific brands or online shops — include both producers that sell direct and established online specialists. Be concrete and specific.',
        query: 'Where is the best place to buy ' + generalCat + ' online' + locationStr + '? Name 3-5 specific brands or shops with a brief reason for each.'
      },
      {
        // Context 3 — PREMIUM/QUALITY TIER: open to the full premium segment.
        // Finds who AI names when a buyer simply wants the best, regardless
        // of business model. Often where category leaders are most visible.
        label: 'Premium category query',
        intent: 'A buyer wanting the best premium option in the category',
        system: 'You are a helpful AI assistant with live web search. Search before answering. Name the specific brand or producer consistently rated as the best quality option. Be direct and specific.',
        query: 'What is the best premium ' + generalCat + locationStr + '? Which brand would you recommend and why? Just give me your single best answer.'
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
    return [
      {
        label: 'B2B vendor discovery',
        intent: 'A procurement decision-maker searching for the best vendor in this category',
        system: 'You are a helpful AI assistant with live web search. Search before answering. Name only real B2B vendors, software providers, or platform companies that sell to businesses — not consumer products or retail brands. Be specific and name real companies.' + hint,
        query: 'What are the best ' + b2bCat + ' vendors' + locationStr + '? Name 3-5 specific companies with a brief reason for each.'
      },
      {
        label: 'B2B solution comparison',
        intent: 'A business evaluating competing platforms or solutions',
        system: 'You are a helpful AI assistant with live web search. Search for current reviews, analyst reports, and industry comparisons before answering — do not rely on memory alone. Name the specific companies that B2B buyers most consistently consider and recommend. Be specific and name real companies.' + hint,
        query: 'Which ' + b2bCat + ' solutions are most recommended for businesses' + locationStr + '? Which providers or platforms do companies in this space choose and why?'
      },
      {
        label: 'B2B direct recommendation',
        intent: 'A business decision-maker ready to select a vendor',
        system: 'You are a helpful AI assistant. Answer from the perspective of advising a business technology decision-maker. Be specific and name one real company or platform.' + hint,
        query: 'Which ' + b2bCat + ' provider would you recommend to a company' + forStr + '? Give me your single best recommendation and explain why.'
      }
    ];
  }

  // Standard buyer queries — correct for retailers, marketplaces, services
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

// GROUND_TRUTH_SAMPLES: how many independent, parallel search-grounded
// attempts each ground-truth query gets. Raised from 2 \u2192 4 to build a real
// frequency signal (who gets named, how often) instead of a single yes/no.
// All samples fire concurrently (Promise.allSettled), so this costs API
// spend, not wall-clock time \u2014 12 parallel calls take the same time as 3.
var GROUND_TRUTH_SAMPLES = 4;

async function runQuerySet(queries, name, useSearch) {
  var sampleCount = useSearch ? GROUND_TRUTH_SAMPLES : 1;

  // Fire every (query \u00d7 sample) combination in one parallel batch.
  var jobs = [];
  queries.forEach(function(q, qi) {
    for (var s = 0; s < sampleCount; s++) jobs.push({ qi: qi, q: q });
  });
  var settled = await Promise.allSettled(
    jobs.map(function(j) { return runQuery(j.q.system, j.q.query, !!useSearch); })
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
      response: shown,
      appeared: appearances.length > 0,
      sampleCount: responses.length,
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
  var prompt = 'Translate these three buyer search queries into natural, native ' + langName
    + ' \u2014 phrased exactly as a local customer would type them to an AI assistant. '
    + 'CRITICAL: preserve every specific breed, material, technology, certification, or niche term EXACTLY \u2014 translate it, never generalize it away. '
    + 'Example: "Black Angus beef" must become the specific German term for Black Angus beef, NOT a generic word for "beef" or "meat". Losing the specific term changes what the question is actually asking. '
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
  // Rich context from evidence gathering — used to understand the business
  // beyond what the user typed in the category field.
  var websiteContext    = String(input.websiteContext   || '').trim().slice(0, 1200);
  var kgText            = String(input.kgText           || '').replace(/^None$/i, '').trim().slice(0, 400);
  var competitorDomains = Array.isArray(input.competitorDomains)
    ? input.competitorDomains.filter(Boolean).slice(0, 10) : [];
  var knownCompetitors  = String(input.knownCompetitors || '').trim();

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
  var businessModel = 'standard';
  var catLower = catClean.toLowerCase();
  var descLower = description.toLowerCase();
  var webLower  = websiteContext.toLowerCase();
  var combined = catLower + ' ' + descLower + ' ' + webLower;
  if (
    /vertically.integrat|owns.its.own|direct.from.farm|farm.to.consumer|farm.brand|direct.to.consumer|farm.owned|own.herd|own.farm|own.production|own.ranch|eigene.farm|eigene.herde|direkt.vom.erzeuger|direkt.von.der.farm/i.test(combined) ||
    (/farm|ranch|herd|pasture|weide|herde/i.test(combined) && /direct|brand|d2c|dtc|online|delivery|versand/i.test(combined))
  ) {
    businessModel = 'farm_brand_dtc';
  } else if (
    /b2b|wholesale|distributor|supplier.*business|business.*supplier/i.test(combined) ||
    /\bfor\s+(operators?|enterprises?|broadcasters?|carriers?|telecoms?|pay.tv|msso?|mvpd|isp|oems?|manufacturers?|developers?|agencies|corporations?)\b/i.test(combined) ||
    /\b(middleware|saas|white.label|white\s+label|api\s+platform|sdk|enterprise\s+software|b2b\s+software|operator\s+platform|headend|backend\s+platform)\b/i.test(combined)
  ) {
    businessModel = 'b2b';
  } else if (/marketplace|platform|aggregator|multi.brand|curates|resell/i.test(combined)) {
    businessModel = 'marketplace';
  }

  return {
    name: name, category: category, city: city, catClean: catClean,
    description: description, businessModel: businessModel,
    websiteContext: websiteContext, kgText: kgText,
    competitorDomains: competitorDomains, knownCompetitors: knownCompetitors
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
    'BUSINESS NAME: ' + n.name,
    'CATEGORY (user typed): ' + n.category,
    'CATEGORY (engine inferred from evidence): ' + n.catClean
  ];
  if (n.description)               contextParts.push('DESCRIPTION: ' + n.description);
  if (n.websiteContext)             contextParts.push('WEBSITE CONTENT (excerpt): ' + n.websiteContext);
  if (n.kgText)                     contextParts.push('KNOWLEDGE GRAPH: ' + n.kgText);
  if (n.competitorDomains.length)   contextParts.push('RELATED DOMAINS FROM SEARCH: ' + n.competitorDomains.join(', '));
  if (n.knownCompetitors)           contextParts.push('KNOWN COMPETITORS: ' + n.knownCompetitors);

  var prompt =
    'You are designing AI simulation queries for a competitive intelligence tool.\n\n'
    + 'BUSINESS CONTEXT:\n' + contextParts.join('\n') + '\n\n'
    + 'YOUR TASK:\n'
    + '1. Determine whether this business is B2B (sells to other businesses, operators, enterprises, developers, or organizations) or B2C (sells directly to individual consumers).\n'
    + '   Use ALL context provided — not just the category label. Check what the website content describes, who the knowledge graph says they serve, what the competitor domains suggest, what the description says.\n\n'
    + '2. Generate 3 queries that a REAL BUYER of this business type would actually type into an AI assistant (ChatGPT, Claude, Perplexity) when looking for solutions in this space.\n'
    + '   - Query 1 (Discovery): "What vendors / providers / companies exist in this specific space?" — must name a specific product type and buyer type.\n'
    + '   - Query 2 (Vendor comparison): "Which companies are the main players and how do they compare?" — MUST ask about comparing NAMED VENDORS, not about strategy (never ask "build vs. buy" or "in-house vs. outsource" — those produce strategy advice, not vendor names).\n'
    + '   - Query 3 (Direct recommendation): "Which specific vendor or provider should I choose for my exact situation?" — must name the buyer type and their specific context so AI recommends a real named company.\n\n'
    + 'CRITICAL RULES:\n'
    + '- ALL THREE queries must be designed to make AI name REAL COMPETING COMPANIES. If a query could be answered with general advice instead of company names, rewrite it.\n'
    + '- B2B: use procurement language — "which vendor", "best platform for [operator/enterprise type]", "which providers do [buyer type] use for...". NEVER "build vs. buy", NEVER "in-house vs. outsource" — these produce strategy answers, not competitor names.\n'
    + '- B2C: use consumer shopping language — "best brand", "where to buy", "which one should I get".\n'
    + '- Be specific to the exact niche vocabulary (e.g. for pay-TV middleware: "IPTV middleware vendor", "OTT platform provider", "white-label TV platform for telcos"; for premium beef: "grass-fed beef brand"; for legal tech: "contract management software vendors").\n'
    + '- DO NOT mention ' + n.name + ' in any query.\n'
    + '- DO NOT use category terms so broad they trigger consumer product results (e.g. "entertainment platform" could mean Netflix — use "middleware vendor" or "B2B OTT platform" instead).\n\n'
    + 'Return ONLY this JSON (no markdown, no explanation):\n'
    + '{"buyerType":"b2b","reasoning":"one sentence explaining why B2B or B2C","queries":["query 1","query 2","query 3"]}';

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
      var text = (data.content || [])
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; }).join('').trim();
      var clean = text.replace(/```json|```/g, '').trim();
      var parsed = JSON.parse(clean);
      if (parsed && Array.isArray(parsed.queries) && parsed.queries.length >= 3) {
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
  if (queryPlan && Array.isArray(queryPlan.queries) && queryPlan.queries.length >= 3) {
    console.log('[simulation] Query plan: buyerType=' + queryPlan.buyerType + ' — ' + (queryPlan.reasoning || ''));
    // System prompt omits "with live web search" when search is disabled,
    // so the model answers from training rather than spinning up a search round-trip.
    var systemPromptBase = queryPlan.buyerType === 'b2b'
      ? (useWebSearch
          ? 'You are a helpful AI assistant with live web search. Search before answering. Name only real B2B vendors, software providers, or platform companies — not consumer products or retail brands. Be specific and name real companies.'
          : 'You are a helpful AI assistant. Name only real B2B vendors, software providers, or platform companies — not consumer products or retail brands. Be specific and name real companies.')
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
    rawQueries = buildQueries(n.catClean, n.city, n.name, n.businessModel);
  }

  var buyerQueries = await generateBuyerQueries(n, rawQueries);
  var loc = await applyMarketLanguage(buyerQueries, n.city, input.language);
  var results = await runQuerySet(loc.queries, n.name, useWebSearch);
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

module.exports = { runSimulation: runSimulation, runBeforeSimulation: runBeforeSimulation, runAfterSimulation: runAfterSimulation };
