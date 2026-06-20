// lib/claude.js
// CHOIVE™ evidence-first scoring engine
// ENV: ANTHROPIC_API_KEY

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS      = 90000;
const MAX_TOKENS      = 4500;

function truncate(text, max) {
  max = max || 4000;
  var value = String(text || '');
  return value.length > max ? value.slice(0, max) : value;
}

// ── Fast category inference ───────────────────────────────────────────────────
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
    return category;
  }
}

// ── Main scoring ──────────────────────────────────────────────────────────────
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
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    var data = await response.json();
    if (data.stop_reason && data.stop_reason !== 'end_turn') {
      console.warn('[CHOIVE] Unexpected stop_reason:', data.stop_reason);
    }
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
    .trim();
  try { return JSON.parse(clean); } catch (_) {}
  var start = clean.indexOf('{');
  var end   = clean.lastIndexOf('}');
  if (start > 0) { console.log('[CHOIVE] Non-JSON prefix:', JSON.stringify(clean.slice(0, Math.min(start, 100)))); }
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }
  console.error('Claude parse failed. Raw start:', text.slice(0, 300));
  console.error('Claude parse failed. Raw end:', text.slice(-300));
  console.error('Claude parse failed. Total length:', text.length);
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
    overallScore:          Number(r.overallScore) || 0,
    verdictHeadline:       r.verdictHeadline      || '',
    summaryParagraph:      r.summaryParagraph     || '',
    businessUnderstanding: r.businessUnderstanding || r.summaryParagraph || '',
    evidenceNarrative:     r.evidenceNarrative    || '',
    inferredCategory:      r.inferredCategory     || '',
    signatureLine:         r.signatureLine        || '',
    marketPosition:        r.marketPosition       || { tier: 'unknown', reasoning: '' },
    platformCoverage:      r.platformCoverage     || { chatgpt: 'weak', perplexity: 'weak', gemini: 'weak', claude: 'weak' },
    selectionGap:          r.selectionGap         || 0,
    pillars: {
      clarity:    safePillar(pillars.clarity),
      trust:      safePillar(pillars.trust),
      difference: safePillar(pillars.difference),
      ease:       safePillar(pillars.ease)
    },
    competitors:  Array.isArray(r.competitors) ? r.competitors.filter(function(c) { return c && c.name; }) : [],
    competitor:   r.competitor  || null,
    actions:      Array.isArray(r.actions) ? r.actions : [],
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
  var socialDisplay = socialList.length > 0 ? socialList.join(', ') : 'None detected in search results.';

  var visibilityText = visibilityPosition !== -1
    ? 'YES (position ' + (visibilityPosition + 1) + ')'
    : 'NO';

  var prompt = 'BUSINESS:\n'
    + 'Name: ' + name + '\n'
    + 'Category: ' + category + '\n'
    + 'Location: ' + city + '\n'
    + 'Website: ' + website + '\n'
    + 'Description: ' + description + '\n'
    + (knownCompetitors ? '\nKNOWN COMPETITORS (provided by user): ' + knownCompetitors + '\n' : '')
    + '\nINFERRED OFFICIAL SITE: ' + inferredSite
    + '\n\nKNOWLEDGE GRAPH:\n' + kgText
    + '\n\nWEBSITE CONTENT:\n' + websiteText
    + '\n\nSEARCH EVIDENCE (grouped by signal type):\n' + searchText
    + '\n\nCOMPETITORS APPEARING IN SEARCH:\n' + competitorText
    + (competitorPageText ? '\n\nCOMPETITOR PAGE FETCHED (' + competitorDomain + '):\n' + competitorPageText : '')
    + '\n\nSOCIAL PRESENCE DETECTED:\n' + socialDisplay
    + '\n\nSOCIAL MEDIA PAGE CONTENT:\n' + socialText
    + '\n\nREVIEW PLATFORM CONTENT:\n' + reviewText
    + (apifyText ? '\n\nLIVE REVIEW DATA:\n' + apifyText : '')
    + '\n\nEVIDENCE SUMMARIES:\n'
    + 'Reviews: '     + (summaries.reviewSummary     || 'No review data.') + '\n'
    + 'Reputation: '  + (summaries.reputationSummary || 'No reputation data.') + '\n'
    + 'Authority: '   + (summaries.authoritySummary  || 'No authority data.') + '\n'
    + 'Competitors: ' + (summaries.competitorSummary || 'No competitor data.') + '\n'
    + '\nWEBSITE VISIBLE IN SEARCH: ' + visibilityText
    + '\n\n---\n'
    + 'YOU ARE CHOIVE\u2122 \u2014 A DECISION INTELLIGENCE ENGINE.\n\n'
    + 'YOUR ONLY JOB:\n'
    + 'Determine why a customer would or would not choose this business over alternatives.\n\n'
    + 'STRICT RULES:\n'
    + '1. Use ONLY the evidence provided above. No prior knowledge. No assumptions.\n'
    + '2. Every score must be justified by specific evidence.\n'
    + '3. If a signal is missing, say it is missing. Do not invent it.\n'
    + '4. Every pillar finding must quote or directly reference specific evidence.\n'
    + '5. Competitor must appear directly in the search evidence. If none clearly appears, return null.\n'
    + '6. Platform coverage must reflect what the evidence actually shows.\n\n'
    + 'STEP 0 \u2014 INFER REAL CATEGORY FROM EVIDENCE:\n'
    + 'User provided category: "' + category + '" \u2014 this may be vague or incorrect.\n'
    + 'Using ONLY the evidence, determine:\n'
    + '1. What does this business actually sell?\n'
    + '2. Who buys it \u2014 consumer, SMB, enterprise, telco, automotive?\n'
    + '3. What precise industry category would buyers use to find this?\n'
    + '4. B2B, B2C, or both?\n'
    + 'Set inferredCategory in the JSON. Do not write this as prose.\n'
    + 'Examples: OTT platform \u2192 B2B OTT middleware platform vendor. Coffee shop \u2192 B2C specialty coffee brand.\n\n'
    + 'DECISION ENVIRONMENT \u2014 classify first:\n'
    + '- discovery_driven: local, map-based, search-based selection\n'
    + '- comparison_driven: evaluated against alternatives before decision\n'
    + '- authority_driven: selected based on reputation, partnerships, capability\n'
    + '- default_driven: category leader chosen automatically\n\n'
    + 'SCORING \u2014 four pillars, each 0-25:\n\n'
    + 'CLARITY (0-25): How precisely and consistently is this business defined?\n'
    + '- Score 20+: specific H1, clear category, consistent naming across all sources\n'
    + '- Score 10-19: partially defined, some inconsistency\n'
    + '- Score 0-9: vague, inconsistent, or undefined\n'
    + '- Required: quote the actual H1 or description found in evidence\n\n'
    + 'TRUST (0-25): How much independent third-party verification exists?\n'
    + '- Score 20-25: multiple strong independent citations \u2014 press, reviews, partnerships all confirmed\n'
    + '- Score 15-19: solid third-party signals \u2014 named client testimonials from known companies,\n'
    + '  OR verified review platform presence with ratings, OR confirmed press coverage\n'
    + '- Score 8-14: some third-party signals but limited \u2014 one or two sources only\n'
    + '- Score 0-7: only owned channels, no independent confirmation found\n'
    + '- RULE: named executive testimonials from Fortune 500 or major enterprise clients\n'
    + '  with full name and title count as strong trust signals \u2014 score minimum 15\n'
    + '- RULE: global top-tier firms (Magic Circle law, Big Four accounting) = minimum 16\n'
    + '- RULE: Legal 500 or Chambers rankings count as strong independent citations\n'
    + '- RULE: for consumer brands, count exact review numbers visible in evidence\n'
    + '  330 Facebook likes + 1 review = score 4-6. 50+ Trustpilot reviews = score 14+\n'
    + '- Required: name specific sources AND exact numbers\n\n'
    + 'TRUST ACTION RULE:\n'
    + 'When trust is low, action body must state:\n'
    + '1. Exactly what was found\n'
    + '2. The number needed to be credible in this category\n'
    + '3. The specific platform that matters most for this buyer type\n\n'
    + 'DIFFERENCE (0-25): Can someone explain why to choose this over alternatives?\n'
    + '- Score 20-25: specific, unique differentiator clearly stated and easy to repeat\n'
    + '- Score 15-19: real differentiator visible \u2014 named niche, named enterprise clients, unique use case\n'
    + '- Score 8-14: differentiator exists but vague or easy to copy\n'
    + '- Score 0-7: completely generic \u2014 no niche, no unique clients, no distinct use case\n'
    + '- CRITICAL: a business with named automotive partnerships (Sk\u014dda, Zeekr, Geely)\n'
    + '  AND named telco clients (TELUS, Proximus) AND 15+ years in a niche CANNOT score below 14\n'
    + '- Required: quote the actual differentiator, or state precisely why none exists\n\n'
    + 'EASE (0-25): How quickly and confidently can this business be understood and selected?\n'
    + '- Score 20-25: schema + llms.txt + complete metadata + strong search visibility\n'
    + '- Score 14-19: schema present + complete metadata but no llms.txt\n'
    + '- Score 8-13: partial structured signals \u2014 OG tags + some metadata, no schema\n'
    + '- Score 4-7: basic web presence \u2014 website works, OG tags present, no schema, no llms.txt\n'
    + '- Score 0-3: no structured signals at all, or website inaccessible\n'
    + '- CRITICAL: if evidence says Schema found: YES \u2014 score MINIMUM 14\n'
    + '- CRITICAL: schema missing entirely = ease cannot exceed 8\n'
    + '- Required: state exactly which signals were found and which were absent\n\n'
    + 'COMPETITOR RULE:\n'
    + 'Only name a competitor if ALL of these are true:\n'
    + '1. The competitor domain or name appears in the search evidence above\n'
    + '2. It is in the exact same category as this business\n'
    + '3. It competes for the same buyer type at the same deal size\n'
    + '4. It is not a directory, review platform, aggregator, or listing site\n'
    + '5. It would realistically appear in the same sales conversation\n'
    + 'If no competitor meets all criteria, return null for all competitor fields.\n\n'
    + 'IF THE USER PROVIDED KNOWN COMPETITORS — THIS IS AN ADDITIONAL CHECK, NOT A REPLACEMENT:\n'
    + 'This section ONLY applies if a "KNOWN COMPETITORS (provided by user)" line actually appears\n'
    + 'above in the BUSINESS section. If that line is absent, SKIP this section entirely and go\n'
    + 'straight to "SCAN ALL EVIDENCE" below — do not treat the absence of known competitors as\n'
    + 'a reason to return fewer or no competitors.\n'
    + 'If that line IS present, it is verified ground truth from the business owner — more reliable\n'
    + 'than generic search results. For each name in that list:\n'
    + '1. Search the evidence above for any mention of that name, even a brief one.\n'
    + '2. If found anywhere in the evidence, include it as a competitor and build the\n'
    + '   advantage/gapLocation/closeGap fields from whatever evidence exists about it.\n'
    + '3. A user-provided name found in evidence takes priority over unnamed competitors.\n'
    + '4. If none of the user-provided names appear in evidence, do not invent evidence for them —\n'
    + '   proceed to the general scanning rules below using only what search evidence shows.\n\n'
    + 'SCAN ALL EVIDENCE — DO NOT STOP AT THE FIRST MATCH:\n'
    + 'Search evidence often names MULTIPLE competitors in a single sentence or quote\n'
    + '(e.g. "brands like X and Y" or "competitors include A, B, and C").\n'
    + 'Read every search result, every quoted sentence, and every competitor list in the evidence.\n'
    + 'If TWO OR MORE distinct names meeting all 5 criteria above appear ANYWHERE in the evidence,\n'
    + 'you MUST return all of them (up to 3) — do not arbitrarily stop after finding only one.\n'
    + 'Returning only 1 competitor when 2+ valid ones exist in evidence is an incomplete answer.\n\n'
    + 'GEOGRAPHIC COVERAGE — IMPORTANT:\n'
    + 'Return UP TO 3 competitors in the competitors array. If the search evidence contains\n'
    + 'competitors from MULTIPLE geographies, prioritise returning a MIX:\n'
    + '- One LOCAL or REGIONAL competitor (same country/region as this business) if one appears in evidence\n'
    + '- One INTERNATIONAL or GLOBAL competitor (different country, but same category/buyer type) if one appears in evidence\n'
    + 'A buyer often compares against both a known local option AND a global brand — show both when evidence supports it.\n'
    + 'Do not default to only international competitors just because they are more prominent in search results.\n'
    + 'Do not invent a local competitor if none appears in evidence — only surface what the evidence actually shows.\n\n'
    + 'IF NO VALID COMPETITOR FOUND IN SEARCH EVIDENCE:\n'
    + 'Use inferredCategory to name the most likely real competitor.\n'
    + 'Set competitor.queryContext = "category-based analysis" to flag this.\n\n'
    + 'COMPETITOR ANALYSIS DEPTH:\n'
    + 'advantage: one sentence \u2014 what specific structural or positioning advantage do they have?\n'
    + 'gapLocation: one sentence \u2014 at what exact point in selection does this hurt the business?\n'
    + 'closeGap: one sentence \u2014 what single specific change would close this gap?\n\n'
    + 'PLATFORM COVERAGE RULE:\n'
    + '- present: clearly findable OR marketPosition.tier is dominant\n'
    + '- weak: appears in search results but lacks structured signals OR tier is strong\n'
    + '- absent: genuinely no evidence \u2014 only for unknown or very new businesses\n'
    + '- RULE: dominant tier = PRESENT on all platforms. No exceptions.\n'
    + '- RULE: strong tier = minimum WEAK on all platforms.\n\n'
    + 'MARKET POSITION TIERS:\\n'
    + 'dominant: household name globally — Nike, Starbucks, Salesforce, McKinsey, Freshfields\\n'
    + '  Magic Circle law firms = dominant. Big Four accounting = dominant.\\n'
    + 'strong: well-known in category — named by buyers without prompting.\\n'
    + 'upper_mid: known within category but requires some discovery.\\n'
    + 'mid: present but requires active search. Regional or niche B2B player.\\n'
    + 'weak: limited presence — hard to find without knowing the name.\\n'
    + 'absent: no detectable presence in evidence.\\n'
    + 'CRITICAL TIER RULES:\\n'
    + '- A B2B niche vendor with Fortune 500 clients = mid or upper_mid, NOT strong or dominant\\n'
    + '- Strong/dominant = known by buyers WITHOUT being searched for\\n'
    + '- Technical gaps do NOT lower tier. Tier = real-world selection likelihood.\\n'
    + '- When uncertain: use the lower tier\\n'
    + '- dominant/strong summary: THIS BUSINESS IS CURRENTLY CHOSEN\\n'
    + '- upper_mid/mid/weak/absent summary: THIS BUSINESS IS NOT THE OBVIOUS CHOICE\\n\\n'
    + 'CHOIVE LANGUAGE STANDARD:\n'
    + 'WHAT CHOIVE IS: A business selection diagnostic. Why a business is chosen, overlooked, trusted, compared, or ignored.\n'
    + 'NOT an SEO audit. NOT an AI visibility tool. Focus on SELECTION.\n'
    + 'NEVER WRITE: AI cannot understand / AI does not know / AI cannot categorize\n'
    + 'INSTEAD WRITE: not consistently selected / recommendation confidence low / selection friction exists\n'
    + 'TRUST: Named Fortune 500 clients, partnerships, long history = HIGH TRUST. Review volume alone is not trust.\n'
    + 'EASE: How quickly understood, categorized, selected. Schema is one factor, not the whole score.\n'
    + 'COMPETITORS: Only from evidence. Never invent. If none found: No dominant comparison pattern detected.\n'
    + 'RECOMMENDATIONS: Explain outcome not task. BAD: Add schema. GOOD: Make this business easier to compare.\n'
    + 'TONE: Strategic advisor. Strong reputation, weak comparison visibility. Trusted provider, weak selection signals.\n\n'
    + 'PILLAR FINDINGS \u2014 USE THESE EXACT FORMATS:\n'
    + 'Clarity finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Trust finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Difference finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Ease finding: [one short phrase, max 6 words, no punctuation]\n\n'
    + 'PILLAR ANALYSIS \u2014 2 sentences each:\n'
    + 'Sentence 1: What is true about this pillar based on evidence?\n'
    + 'Sentence 2: What is the selection consequence?\n\n'
    + 'VERDICT HEADLINE \u2014 max 10 words, no punctuation, strategic advisor tone\n\n'
    + 'SUMMARY PARAGRAPH \u2014 exactly 3 sentences:\n'
    + '- If tier is dominant or strong: start with "This business is currently chosen because..."\n'
    + '- If tier is upper_mid, mid, weak, absent: start with "This business is not the obvious choice because..."\n'
    + '- Sentence 2: the single strongest evidence-based driver or gap\n'
    + '- Sentence 3: the consequence for selection \u2014 this MUST be concrete and specific, not abstract.\n'
    + '  Name the exact moment in the buyer journey where this business is lost (e.g. "at the comparison\n'
    + '  stage, before first contact" or "when a buyer searches for [category] and sees competitors first").\n'
    + '  BAD (too abstract): "This creates selection friction for buyers."\n'
    + '  GOOD (concrete): "A buyer comparing three [category] options will encounter [competitor] first and\n'
    + '  may never reach this business at all."\n'
    + '  Do not invent numbers, percentages, or revenue figures that are not present in the evidence \u2014\n'
    + '  the specificity must come from naming the moment and the mechanism, not fabricated statistics.\n\n'
    + 'ACTION RULES:\\n'
    + '- Actions must be specific to this business\\n'
    + '- Body must cite actual evidence found\\n'
    + '- Explanation must explain the selection consequence, not the technical task\\n'
    + '- TITLE BANNED WORDS: schema, schema markup, JSON-LD, llms.txt, metadata, canonical — never in title\\n'
    + '- TITLE GOOD: Make this business machine-readable, Define your business for AI systems, Close the comparison gap\\n'
    + '- TITLE BAD: Add schema markup to homepage, Create llms.txt file, Implement JSON-LD\\n'
    + '- Body/explanation use: structured presence, machine-readable definition, comparison signals\\n'
    + '- BANNED WORDS — NEVER use in action title OR body: JSON-LD, schema markup, metadata, canonical, llms.txt\\n'
    + '  BAD: The homepage has no JSON-LD or schema markup — GOOD: The homepage has no structured presence signals\\n'
    + '  BAD: No llms.txt was detected — GOOD: No machine-readable definition file exists for AI systems to cite\\n'
    + '  BAD: Add schema markup — GOOD: Add structured presence that defines this business for automated discovery\\n\\n'
    + 'The example values below show the REQUIRED STRUCTURE only — they are not real content.\n'
    + 'Replace every example value with real content from your analysis above. The competitors\n'
    + 'array must contain REAL competitor data per the COMPETITOR RULE and SCAN ALL EVIDENCE\n'
    + 'sections above — only use null fields if you have already determined zero valid\n'
    + 'competitors exist after actually scanning the evidence, not as a default.\n\n'
    + 'Respond with ONLY the following JSON object. No prose. No markdown. Start with { and end with }.\n\n';

  var jsonSchema = '{\n'
    + '  "overallScore": 0,\n'
    + '  "verdictHeadline": "",\n'
    + '  "summaryParagraph": "",\n'
    + '  "businessUnderstanding": "",\n'
    + '  "evidenceNarrative": "",\n'
    + '  "inferredCategory": "",\n'
    + '  "marketPosition": { "tier": "", "reasoning": "" },\n'
    + '  "platformCoverage": { "chatgpt": "weak", "perplexity": "weak", "gemini": "weak", "claude": "weak" },\n'
    + '  "pillars": {\n'
    + '    "clarity":    { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n'
    + '    "trust":      { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n'
    + '    "difference": { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n'
    + '    "ease":       { "score": 0, "finding": "", "analysis": "", "evidence": "" }\n'
    + '  },\n'
    + '  "competitors": [\n'
    + '    { "name": "ExampleCompetitorName", "advantage": "one sentence", "gapLocation": "one sentence", "closeGap": "one sentence", "evidence": "quoted evidence", "queryContext": "search" }\n'
    + '  ],\n'
    + '  "actions": [\n'
    + '    { "priority": "critical", "title": "", "body": "", "explanation": "" },\n'
    + '    { "priority": "critical", "title": "", "body": "", "explanation": "" },\n'
    + '    { "priority": "high",     "title": "", "body": "", "explanation": "" },\n'
    + '    { "priority": "medium",   "title": "", "body": "", "explanation": "" }\n'
    + '  ]\n'
    + '}';

  return prompt + jsonSchema;
}

module.exports = { scoreWithClaude: scoreWithClaude, inferCategory: inferCategory };
