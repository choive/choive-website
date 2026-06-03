// lib/claude.js
// CHOIVE™ evidence-first scoring engine
// ENV: ANTHROPIC_API_KEY

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const TIMEOUT_MS  = 65000;
const MAX_TOKENS  = 2800;

function truncate(text, max) {
  max = max || 4000;
  var value = String(text || '');
  return value.length > max ? value.slice(0, max) : value;
}


// ── Fast category inference — runs before main scoring ───────────────────────
async function inferCategory(name, category, websiteText, searchText) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 15000);

  var prompt = 'Business name: ' + name + '\n'
    + 'User-provided category: ' + category + '\n'
    + 'Website content (excerpt): ' + String(websiteText || '').slice(0, 800) + '\n'
    + 'Search evidence (excerpt): ' + String(searchText || '').slice(0, 800) + '\n\n'
    + 'Based only on the evidence above, determine the precise real-world category this business operates in.\n'
    + 'Return ONLY a JSON object with one field:\n'
    + '{ "inferredCategory": "precise category name" }\n'
    + 'Be specific. Examples:\n'
    + '- Not "software" but "B2B OTT middleware platform for telcos and carmakers"\n'
    + '- Not "coffee" but "B2B specialty coffee roaster and wholesaler"\n'
    + '- Not "consulting" but "enterprise digital transformation consultancy for financial services"\n'
    + 'Return only raw JSON. No markdown. No explanation.';

  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!response.ok) return category;
    var data = await response.json();
    var text = (data.content || []).filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; }).join('').trim();
    var clean = text.replace(/```json|```/g, '').trim();
    var parsed = JSON.parse(clean);
    return parsed.inferredCategory || category;
  } catch (err) {
    clearTimeout(timer);
    return category; // fallback to user input
  }
}

async function scoreWithClaude(evidence) {
  var prompt = buildPrompt(evidence);
  var controller = new AbortController();
  var timeout = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);

  try {
    var response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a JSON-only response engine. You MUST respond with a single valid JSON object and absolutely nothing else. No prose, no markdown, no explanation, no preamble, no steps. Your entire response must start with { and end with }. Any text outside the JSON object will break the system.',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    var data = await response.json();

    if (!response.ok) {
      throw new Error(data && data.error && data.error.message ? data.error.message : 'Anthropic HTTP ' + response.status);
    }

    return safeOutput(parseClaudeResponse(data));
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') throw new Error('Claude request timed out');
    throw error;
  }
}

function parseClaudeResponse(data) {
  var text = (data.content || [])
    .filter(function(b) { return b.type === 'text'; })
    .map(function(b) { return b.text || ''; })
    .join('')
    .trim();

  if (!text) throw new Error('Claude returned empty response');

  var clean = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/]*>/gi, '')
    .replace(/<\/antml:cite>/gi, '')
    .replace(/<antCiting[^>]*\/>/gi, '')
    .trim();

  try { return JSON.parse(clean); } catch (_) {}

  // Try extracting first complete JSON object
  // Find the outermost JSON object
  var start = clean.indexOf('{');
  var end   = clean.lastIndexOf('}');
  if (start > 0) { console.log('[CHOIVE] Non-JSON prefix:', JSON.stringify(clean.slice(0, Math.min(start, 100)))); }
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }

  console.error('Claude parse failed. Raw:', text.slice(0, 300));
  throw new Error('Could not parse Claude response as JSON');
}

function safeOutput(raw) {
  var r = raw || {};
  var pillars = r.pillars || {};
  function safePillar(p) {
    p = p || {};
    return { score: Number(p.score) || 0, finding: p.finding || '', analysis: p.analysis || '', evidence: p.evidence || '' };
  }
  return {
    overallScore:        Number(r.overallScore) || 0,
    verdictHeadline:     r.verdictHeadline     || '',
    summaryParagraph:    r.summaryParagraph    || '',
    businessUnderstanding: r.businessUnderstanding || r.summaryParagraph || '',
    evidenceNarrative:   r.evidenceNarrative   || '',
    inferredCategory:    r.inferredCategory    || '',
    signatureLine:       r.signatureLine       || '',
    marketPosition:      r.marketPosition      || { tier: 'unknown', reasoning: '' },
    platformCoverage:    r.platformCoverage    || { chatgpt: 'weak', perplexity: 'weak', gemini: 'weak', claude: 'weak' },
    selectionGap:        r.selectionGap        || 0,
    pillars: {
      clarity:    safePillar(pillars.clarity),
      trust:      safePillar(pillars.trust),
      difference: safePillar(pillars.difference),
      ease:       safePillar(pillars.ease)
    },
    competitors: Array.isArray(r.competitors) ? r.competitors.filter(function(c) { return c && c.name; }) : [],
    competitor:  r.competitor || null,
    actions:     Array.isArray(r.actions) ? r.actions : [],
    deliverables: r.deliverables || null
  };
}

function buildPrompt(evidence) {
  var name               = evidence.name        || '';
  var category           = evidence.category    || '';
  var city               = evidence.city        || '';
  var website            = evidence.website     || 'not provided';
  var description        = evidence.description || 'not provided';
  var inferredSite       = evidence.inferredOfficialSite || 'not found';
  var websiteText        = truncate(evidence.websiteText, 3000)  || 'No website content available.';
  var searchText         = truncate(evidence.searchText, 5000)   || 'No search results returned.';
  var kgText             = truncate(evidence.kgText, 1200)       || 'None';
  var visibilityPosition = evidence.visibilityPosition;
  var competitors        = evidence.competitors        || [];
  var knownCompetitors   = evidence.knownCompetitors   || '';
  var competitorDomain   = evidence.competitorDomain   || '';
  var competitorPageText = evidence.competitorPageText || '';
  var socialText         = evidence.socialText         || 'No social media pages found.';
  var reviewText         = evidence.reviewText         || 'No review platform pages found.';
  var apifyText          = evidence.apifyText          || '';
  var socialSignals      = evidence.socialSignals || {};
  var summaries          = evidence.summaries     || {};

  var competitorText = competitors.length > 0
    ? competitors.map(function(c) { return '- ' + c.domain + ': ' + (c.snippet || ''); }).join('\n')
    : 'No clear competitors identified in search results.';

  var socialList = Object.keys(socialSignals).filter(function(k) { return socialSignals[k]; });
  var socialText = socialList.length > 0 ? socialList.join(', ') : 'None detected in search results.';

  var visibilityText = visibilityPosition !== -1
    ? 'YES (position ' + (visibilityPosition + 1) + ')'
    : 'NO';

  return 'BUSINESS:\n' +
    'Name: ' + name + '\n' +
    'Category: ' + category + '\n' +
    'Location: ' + city + '\n' +
    'Website: ' + website + '\n' +
    'Description: ' + description + '\n' +
    (knownCompetitors ? '\nKNOWN COMPETITORS (provided by user): ' + knownCompetitors + '\n' : '') +
    '\nINFERRED OFFICIAL SITE: ' + inferredSite +
    '\n\nKNOWLEDGE GRAPH:\n' + kgText +
    '\n\nWEBSITE CONTENT:\n' + websiteText +
    '\n\nSEARCH EVIDENCE (grouped by signal type):\n' + searchText +
    '\n\nCOMPETITORS APPEARING IN SEARCH:\n' + competitorText +
    (competitorPageText ? '\n\nCOMPETITOR PAGE FETCHED (' + competitorDomain + '):\n' + competitorPageText : '') +
    '\n\nSOCIAL PRESENCE DETECTED (from search results):\n' + socialList +
    '\n\nSOCIAL MEDIA PAGE CONTENT (fetched from detected pages):\n' + socialText +
    '\n\nREVIEW PLATFORM CONTENT (fetched pages):\n' + reviewText +
    (apifyText ? '\n\nLIVE REVIEW DATA (Trustpilot + Google Reviews):\n' + apifyText : '') +
    '\n\nEVIDENCE SUMMARIES:\n' +
    'Reviews: '     + (summaries.reviewSummary     || 'No review data.') + '\n' +
    'Reputation: '  + (summaries.reputationSummary || 'No reputation data.') + '\n' +
    'Authority: '   + (summaries.authoritySummary  || 'No authority data.') + '\n' +
    'Competitors: ' + (summaries.competitorSummary || 'No competitor data.') + '\n' +
    '\nWEBSITE VISIBLE IN SEARCH: ' + visibilityText +

    '\n\n---\n' +
    'YOU ARE CHOIVE™ — A DECISION INTELLIGENCE ENGINE.\n\n' +

    'YOUR ONLY JOB:\n' +
    'Determine why a customer would or would not choose this business over alternatives.\n\n' +

    'STRICT RULES — READ CAREFULLY:\n' +
    '1. Use ONLY the evidence provided above. No prior knowledge. No assumptions.\n' +
    '2. Every score must be justified by specific evidence from the data above.\n' +
    '3. If a signal is missing, say it is missing. Do not invent it.\n' +
    '4. Every pillar finding must quote or directly reference specific evidence.\n' +
    '5. Competitor must appear directly in the search evidence above. If none clearly appears, return null.\n' +
    '6. Platform coverage must reflect what the evidence actually shows — not assumptions about company size.\n' +
    '7. DO NOT reward signals that are not present in the evidence.\n' +
    '8. DO NOT penalise signals that are clearly present in the evidence.\n\n' +

    'Set inferredCategory in your JSON to the precise business category inferred from evidence.\\n' +
    'User-provided category: "' + category + '" — verify against evidence.\\n' +
    'Use B2B/B2C prefix. Examples: B2B OTT middleware platform vendor, B2C premium beef direct-to-consumer.\\n\\n' +    'DECISION ENVIRONMENT — classify first:\n' +
    '- discovery_driven: local, map-based, search-based selection\n' +
    '- comparison_driven: evaluated against alternatives before decision\n' +
    '- authority_driven: selected based on reputation, partnerships, capability\n' +
    '- default_driven: category leader chosen automatically\n\n' +

    'SCORING — four pillars, each 0-25:\n\n' +

    'CLARITY (0-25): How precisely and consistently is this business defined?\n' +
    '- Score 20+: specific H1, clear category, consistent naming across all sources\n' +
    '- Score 10-19: partially defined, some inconsistency\n' +
    '- Score 0-9: vague, inconsistent, or undefined\n' +
    '- Required: quote the actual H1 or description found in evidence\n\n' +

    'TRUST (0-25): How much independent third-party verification exists?\\n' +
    '- Score 20-25: multiple strong independent citations — press, reviews, partnerships all confirmed\\n' +
    '- Score 15-19: solid third-party signals — named client testimonials from known companies,\\n' +
    '  OR verified review platform presence with ratings, OR confirmed press coverage\\n' +
    '- Score 8-14: some third-party signals but limited — one or two sources only\\n' +
    '- Score 0-7: only owned channels, no independent confirmation found\\n' +
    '- RULE: named executive testimonials from Fortune 500 or major enterprise clients\\n' +
    '  with full name and title count as strong trust signals — score minimum 15\\n' +
    '- RULE: global top-tier firms (Magic Circle law, Big Four accounting) = minimum 16\\n' +
    '- RULE: Legal 500 or Chambers rankings count as strong independent citations\\n' +
    '- RULE: for consumer brands, count exact review numbers visible in evidence\\n' +
    '  330 Facebook likes + 1 review = score 4-6. 50+ Trustpilot reviews = score 14+\\n' +
    '- Required: name specific sources AND exact numbers (e.g. Trustpilot 4.3 from 127 reviews)\\n\\n' +
    'TRUST ACTION RULE:\\n' +
    'When trust is low, action body must state:\\n' +
    '1. Exactly what was found (e.g. only 1 Facebook review found, 330 likes)\\n' +
    '2. The number needed to be credible in this category:\\n' +
    '   premium consumer brand = 50+ reviews minimum\\n' +
    '   B2B software = 10+ G2 or Capterra reviews\\n' +
    '   local service = 20+ Google reviews\\n' +
    '3. The specific platform that matters most for this buyer type\\n\\n' +

    'DIFFERENCE (0-25): Can someone explain why to choose this over alternatives?\n' +
    'Score based on visible evidence only:\n' +
    '- Score 20-25: specific, unique differentiator clearly stated and easy to repeat\n' +
    '  (named niche + unique use case + clear positioning all confirmed in evidence)\n' +
    '- Score 15-19: real differentiator visible in evidence — counts as 15+ if ANY of:\n' +
    '  named niche market (automotive OTT, telco-only, specific vertical)\n' +
    '  named enterprise clients in a specific segment (Škoda, TELUS, Proximus)\n' +
    '  unique use case not common to all competitors (in-vehicle entertainment)\n' +
    '  clear category specialization confirmed by multiple evidence sources\n' +
    '- Score 8-14: differentiator exists but is vague, single-source, or easy to copy\n' +
    '- Score 0-7: completely generic — no niche, no unique clients, no distinct use case\n' +
    'CRITICAL RULE: a business with named automotive partnerships (Škoda, Zeekr, Geely)\n' +
    'AND named telco clients (TELUS, Proximus) AND 15+ years in a specific niche\n' +
    'CANNOT score below 14 on Difference. That is an established niche player.\n' +
    'The tagline quality does not determine Difference score — the niche does.\n' +
    '- Required: quote the actual differentiator found, or state precisely why none exists\n\n' +

    'EASE (0-25): How quickly and confidently can this business be understood and selected?\\n' +
    'Evaluate these signals from evidence:\\n' +
    '- Schema markup (JSON-LD): present = strong signal, absent = weak machine readability\\n' +
    '- llms.txt: present = clear direct signal, absent = no direct machine instruction\\n' +
    '- Structured metadata: OG tags, canonical, meta description — each adds readability\\n' +
    '- Search visibility: how quickly does this business appear when searched?\\n' +
    'Score tiers — apply strictly based on what was found in evidence:\\n' +
    '- Score 20-25: schema + llms.txt + complete metadata + strong search visibility\\n' +
    '- Score 14-19: schema present + complete metadata but no llms.txt\\n' +
    '  (schema IS present = score at least 14, not 4)\\n' +
    '- Score 8-13: partial structured signals — OG tags + some metadata, no schema\\n' +
    '- Score 4-7: basic web presence — website works, OG tags present, no schema, no llms.txt\\n' +
    '- Score 0-3: no structured signals at all, or website inaccessible\\n' +
    'CRITICAL RULE: if evidence says Schema found: YES — score MINIMUM 14\\n' +
    'CRITICAL RULE: schema missing entirely = ease cannot exceed 8\\n' +
    'CRITICAL RULE: working website + OG tags but no schema = 4-7 range\\n' +
    '- Required: state exactly which signals were found and which were absent\\n\\n' +

    'COMPETITOR RULE:\n' +
    'If the user provided known competitors above, use those as primary competitor candidates.\n' +
    'Verify they appear in the search evidence OR are in the same category before including.\n' +
    'Only name a competitor if ALL of these are true:\n' +
    '1. The competitor domain appears in the search evidence above\n' +
    '2. It is in the exact same category as this business\n' +
    '3. It competes for the same buyer type at the same deal size\n' +
    '   (e.g. enterprise vs enterprise, SMB vs SMB — do not mix)\n' +
    '4. It is not a directory, review platform, aggregator, or listing site\n' +
    '5. It would realistically appear in the same sales conversation\n' +
    'Directories like Slashdot, SourceForge, Capterra, G2, Clutch are NOT competitors.\n' +
    'A smaller player serving a different buyer segment is NOT a competitor.\n' +
    'If no competitor meets all five criteria, return null for all competitor fields.\n' +
    'The competitor analysis must explain specifically WHY that competitor appears stronger\n' +
    'based only on visible evidence — not assumptions about market position.\n' +
    'VALIDATION: Would this appear on an enterprise procurement shortlist for this exact category?\n' +
    'If no — return null. Examples that are NOT competitors: Slashdot, SourceForge, ViewLift, any media blog.\n' +
    'Valid B2B OTT middleware competitors: Accedo, Nagra, Kaltura, Synamedia, Amino, Zattoo\\n\\n' +

    'IF NO VALID COMPETITOR FOUND IN SEARCH EVIDENCE:\\n' +
    'Use inferredCategory to name the most likely real competitor.\\n' +
    'Set competitor.queryContext = \'category-based analysis\' to flag this.\\n' +
    'Set competitor.evidence = \'Based on inferred category — not found in search evidence\'\\n' +
    'B2B OTT middleware: name Accedo or Nagra\\n' +
    'B2B HR platform: name Workday or BambooHR\\n' +
    'Local coffee: name Starbucks or dominant local chain\\n' +
    'Only name a competitor you are confident is real. If uncertain — return null.\\n\\n' +

    'COMPETITOR ANALYSIS DEPTH REQUIREMENT:\\n' +
    'competitor.analysis must be 3 sentences minimum. Each sentence must be specific:\\n' +
    'For each competitor use these exact fields:\\n' +
    'advantage: one sentence — what specific structural or positioning advantage do they have?\\n' +
    '  (schema markup, clearer positioning, stronger reviews, higher search position, known brand)\\n' +
    'gapLocation: one sentence — at what exact point in selection does this hurt the business?\\n' +
    '  (comparison search, AI recommendation, procurement shortlist, side-by-side evaluation)\\n' +
    'closeGap: one sentence — what single specific change would close this gap?\\n' +
    'BAD example: Accedo has stronger structured web presence.\\n' +
    'GOOD example: Accedo publishes a detailed platform comparison page and has JSON-LD\\n' +
    'Organization schema, which means it appears as a structured entity in AI-driven vendor\\n' +
    'shortlists while 3SS appears only as a URL. Adding Organization schema would close\\n' +
    'this gap immediately.\\n\\n' +

    'PLATFORM COVERAGE RULE:\n' +
    'Base coverage on evidence AND market position tier:\n' +
    '- present: business is clearly findable and citable on that platform from evidence\n' +
    '  OR marketPosition.tier is dominant (known global brand = present on all platforms)\n' +
    '- weak: business appears in search results but lacks structured signals\n' +
    '  OR marketPosition.tier is strong with confirmed web presence\n' +
    '- absent: genuinely no evidence of presence — only for unknown or very new businesses\n' +
    'RULE: dominant tier = PRESENT on all platforms. No exceptions.\n' +
    'RULE: strong tier = minimum WEAK on all platforms.\n' +
    'RULE: a brand that appears in AI simulation queries = PRESENT on those platforms.\n\n' +

    'MARKET POSITION TIERS:\\n' +
    'dominant: globally or nationally recognized — appears in AI recommendations unprompted\\n' +
    '  Examples: Nike, Starbucks, Nobu, Salesforce, McKinsey, Freshfields, Clifford Chance,\\n' +
    '  Goldman Sachs, Deloitte, Google, Apple — household names in their sector\\n' +
    '  Magic Circle law firms = dominant. Big Four accounting = dominant.\\n' +
    'strong: well-known in category — named by buyers without prompting\\n' +
    '  Examples: Pipedrive, a leading regional restaurant chain, a well-known national brand\\n' +
    'upper_mid: known within category but not immediately top-of-mind\\n' +
    'mid: present but requires active search to find\\n' +
    'weak: limited presence — hard to find without knowing the name\\n' +
    'absent: no detectable presence in evidence\\n\\n' +
    'TIER RULES (critical):\\n' +
    '- Magic Circle law firm = dominant\\n' +
    '- Big Four accounting firm = dominant\\n' +
    '- Michelin-starred global restaurant chain = dominant\\n' +
    '- Global tech platform (Salesforce, HubSpot, etc) = dominant or strong\\n' +
    '- Technical gaps (no schema, no llms.txt) do NOT lower market position tier\\n' +
    '- Tier = real-world selection likelihood, not website quality\\n' +
    '- A dominant brand with poor schema is still dominant\\n' +
    '- The schema gap belongs in Ease score, not tier\\n\\n' +

    'DECISION STATES:\n' +
    'not_seen, seen_not_considered, considered_not_chosen, trusted_not_chosen, chosen_by_default\n\n' +

    'SUMMARY PARAGRAPH — exactly 3 sentences:\n' +
    '- If tier is dominant or strong: start with "This business is currently chosen because..."\n' +
    '- If tier is upper_mid, mid, weak, absent: start with "This business is not the obvious choice because..."\n' +
    '- Sentence 2: the single strongest evidence-based driver or gap\n' +
    '- Sentence 3: the consequence for selection\n\n' +

        'CHOIVE LANGUAGE STANDARD\n=========================\n\n' +
    'WHAT CHOIVE IS:\n' +
    'A business selection diagnostic. Explains why a business is chosen, overlooked, trusted, compared, or ignored.\n' +
    'Not an SEO audit. Not an AI visibility tool.\n\n' +
    'PRIORITY RULE:\n' +
    'If a sentence is technically correct but harder to understand, choose the clearer version.\n' +
    'A business owner must understand the diagnosis within 30 seconds.\n\n' +
    'UNDERSTANDING VS SELECTION:\n' +
    'If you have identified the category, product, customers, positioning, and differentiation,\n' +
    'the business HAS ALREADY BEEN UNDERSTOOD. The question is not understanding. The question is selection.\n\n' +
    'NEVER SAY:\n' +
    '- AI cannot understand the business\n' +
    '- AI does not know what the company does\n' +
    '- AI cannot categorize this business\n' +
    '- machines cannot read this website\n\n' +
    'INSTEAD SAY:\n' +
    '- The business is understood, but not consistently selected during comparison.\n' +
    '- Recommendation confidence is low because...\n' +
    '- Selection friction exists because...\n' +
    '- Comparison readiness is weak because...\n\n' +
    'BANNED TECHNICAL TERMS IN DIAGNOSIS AND RECOMMENDATIONS:\n' +
    'JSON-LD, metadata, canonical tags, schema markup, llms.txt\n' +
    'Replace with: structured web presence, machine-readable definition, comparison signals, selection infrastructure\n\n' +
    'TRUST SCORING RULE:\n' +
    'Trust is NOT the same as review volume.\n' +
    'Named Fortune 500 clients, public case studies, major partnerships, long operating history = HIGH TRUST.\n' +
    'Low review volume alone does NOT mean low trust.\n' +
    'Score trust based on totality of credibility signals.\n\n' +
    'EASE SCORING RULE:\n' +
    'Ease measures how quickly the business can be understood, categorized, and selected.\n' +
    'Schema and llms.txt are factors — NOT the entire Ease score.\n' +
    'Clear positioning, strong search presence, consistent messaging can score well on Ease.\n\n' +
    'COMPETITOR RULE — ABSOLUTE:\n' +
    'Never invent competitors. Only use competitors found in search evidence.\n' +
    'If no competitor found: write exactly "No dominant comparison pattern was detected in the available evidence."\n\n' +
    'RECOMMENDATION LANGUAGE:\n' +
    'Explain the outcome, not the task.\n' +
    'BAD: "Add schema markup." GOOD: "Make this business easier to classify and compare during evaluation."\n' +
    'BAD: "Create llms.txt." GOOD: "Define this business clearly so its positioning is consistently understood."\n' +
    'BAD: "Missing JSON-LD." GOOD: "The business is trusted once discovered, but harder to compare consistently."\n\n' +
    'CHOIVE TONE — STRATEGIC ADVISOR:\n' +
    'Write like a strategic advisor, not an SEO consultant or technical auditor.\n' +
    'Best language: "Strong reputation, weak comparison visibility."\n' +
    '"Trusted provider, weak selection signals." "The business is discovered. The problem is selection."\n\n' +
    'CORE FRAMEWORK:\n' +
    'Discovery: Can people find the business?\n' +
    'Selection: Will people choose the business?\n' +
    'CHOIVE focuses on SELECTION.\n\n' +

    'PILLAR FINDINGS — USE THESE EXACT FORMATS:\n' +
    'Clarity finding: [one short phrase, max 6 words, no punctuation]\n' +
    'Trust finding: [one short phrase, max 6 words, no punctuation]\n' +
    'Difference finding: [one short phrase, max 6 words, no punctuation]\n' +
    'Ease finding: [one short phrase, max 6 words, no punctuation]\n\n' +
    'PILLAR ANALYSIS — 2 sentences each:\n' +
    'Sentence 1: What is true about this pillar based on evidence?\n' +
    'Sentence 2: What is the selection consequence?\n\n' +
    'PILLAR EVIDENCE — quote the exact evidence string, max 200 chars\n\n' +
    'VERDICT HEADLINE — max 10 words, no punctuation, strategic advisor tone\n' +
    'Examples:\n' +
    '- Strong reputation, weak comparison visibility\n' +
    '- Trusted provider, weak selection signals\n' +
    '- Clear expertise, unclear positioning\n' +
    '- The business is discovered. The problem is selection.\n\n' +
    'SUMMARY PARAGRAPH — 3 sentences:\n' +
    'Sentence 1: Why is this business not the obvious choice? (or why it IS if dominant)\n' +
    'Sentence 2: What is the strongest evidence-based driver or gap?\n' +
    'Sentence 3: What is the consequence for selection?\n\n' +
    'COMPETITOR RULE:\n' +
    'Return UP TO 3 competitors in the competitors array.\n' +
    'Only include a competitor if ALL of these are true:\n' +
    '1. The competitor domain appeared in actual search results\n' +
    '2. The competitor is in the same category and serves the same buyer\n' +
    '3. You can explain a specific structural advantage they have\n' +
    'If no real competitor found: set name to null and queryContext to "no-evidence"\n\n' +
    'For each competitor use these exact fields:\n' +
    'advantage: one sentence — what specific structural or positioning advantage do they have?\n' +
    'gapLocation: one sentence — at what exact point in selection does this hurt the business?\n' +
    'closeGap: one sentence — what single specific change would close this gap?\n\n' +
    'ACTION RULES:\n' +
    '- Actions must be specific to this business\n' +
    '- Title must name the exact entity type (e.g. "OTT middleware vendor", "premium beef brand")\n' +
    '- Body must cite actual evidence found\n' +
    '- Explanation must explain the selection consequence, not the technical task\n' +
    '- Never use: JSON-LD, schema markup, metadata, canonical, llms.txt in action body\n' +
    '- Instead use: structured presence, machine-readable definition, comparison signals\n\n';

  var jsonSchema = '{\n' +
    '  "overallScore": 0,\n' +
    '  "verdictHeadline": "",\n' +
    '  "summaryParagraph": "",\n' +
    '  "businessUnderstanding": "",\n' +
    '  "evidenceNarrative": "",\n' +
    '  "inferredCategory": "",\n' +
    '  "marketPosition": { "tier": "", "reasoning": "" },\n' +
    '  "platformCoverage": { "chatgpt": "", "perplexity": "", "gemini": "", "claude": "" },\n' +
    '  "pillars": {\n' +
    '    "clarity":    { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n' +
    '    "trust":      { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n' +
    '    "difference": { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n' +
    '    "ease":       { "score": 0, "finding": "", "analysis": "", "evidence": "" }\n' +
    '  },\n' +
    '  "competitors": [\n' +
    '    { "name": null, "advantage": null, "gapLocation": null, "closeGap": null, "evidence": null, "queryContext": null }\n' +
    '  ],\n' +
    '  "actions": [\n' +
    '    { "priority": "critical", "title": "", "body": "", "explanation": "" },\n' +
    '    { "priority": "critical", "title": "", "body": "", "explanation": "" },\n' +
    '    { "priority": "high",     "title": "", "body": "", "explanation": "" },\n' +
    '    { "priority": "medium",   "title": "", "body": "", "explanation": "" }\n' +
    '  ]\n' +
    '}';

  return systemPrompt + userPrompt + jsonSchema + "\n\nCRITICAL: Respond with ONLY the JSON object. Start your response with { and end with }. No prose, no steps, no markdown, no preamble, no explanation before or after the JSON.";
}

module.exports = { scoreWithClaude: scoreWithClaude, inferCategory: inferCategory };
