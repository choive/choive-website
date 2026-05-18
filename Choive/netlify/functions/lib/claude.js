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
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    var data = await response.json();

    if (!response.ok) {
      throw new Error(data && data.error && data.error.message ? data.error.message : 'Anthropic HTTP ' + response.status);
    }

    return parseClaudeResponse(data);
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
    .trim();

  try { return JSON.parse(clean); } catch (_) {}

  // Try extracting first complete JSON object
  var start = clean.indexOf('{');
  var end   = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }

  console.error('Claude parse failed. Raw:', text.slice(0, 300));
  throw new Error('Could not parse Claude response as JSON');
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

    'STEP 0 — INFER REAL CATEGORY FROM EVIDENCE:\n' +
    'User provided category: "' + category + '" — this may be vague or incorrect.\n' +
    'Using ONLY the evidence, determine:\n' +
    '1. What does this business actually sell?\n' +
    '2. Who buys it — consumer, SMB, enterprise, telco, automotive?\n' +
    '3. What precise industry category would buyers use to find this?\n' +
    '4. B2B, B2C, or both?\n' +
    'Return this as inferredCategory. Use it for all scoring and competitor logic.\n' +
    'Examples:\n' +
    '- User typed OTT platform, evidence shows white-label middleware for telcos → B2B OTT middleware platform vendor\n' +
    '- User typed coffee shop, evidence shows wholesale roastery → B2B specialty coffee roaster\n\n' +

    'DECISION ENVIRONMENT — classify first:\n' +
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

    'TRUST (0-25): How much independent third-party verification exists?\n' +
    '- Score 20-25: multiple strong independent citations — press, reviews, partnerships all confirmed\n' +
    '- Score 15-19: solid third-party signals — named client testimonials from known companies,\n' +
    '  OR verified review platform presence with ratings, OR confirmed press coverage\n' +
    '- Score 8-14: some third-party signals but limited — one or two sources only\n' +
    '- Score 0-7: only owned channels, no independent confirmation found\n' +
    '- RULE: named executive testimonials from Fortune 500 or major enterprise clients\n' +
    '  with full name and title count as strong trust signals — score minimum 15\n' +
    '- Required: name the specific sources found (e.g. Trustpilot, press, client names)\n\n' +

    'DIFFERENCE (0-25): Can someone explain why to choose this over alternatives?\n' +
    'Score based on visible evidence only:\n' +
    '- Score 20-25: specific, unique differentiator clearly stated and easy to repeat\n' +
    '  (named niche + unique use case + clear positioning all confirmed in evidence)\n' +
    '- Score 15-19: real differentiator visible — niche market, named enterprise clients,\n' +
    '  unique use case, or clear category focus — even if not schema-encoded\n' +
    '- Score 8-14: differentiator implied but vague or interchangeable\n' +
    '- Score 0-7: no differentiator found — generic positioning only\n' +
    'RULE: niche specialization + named clients + unique use cases = score 15-19 minimum.\n' +
    'RULE: do not confuse "not machine-readable" with "does not exist".\n' +
    '- Required: quote the actual differentiator found, or state precisely why none exists\n\n' +

    'EASE (0-25): How quickly and confidently can this business be understood and selected?\n' +
    'Evaluate these signals from evidence:\n' +
    '- Schema markup (JSON-LD): present = strong signal, absent = weak machine readability\n' +
    '- llms.txt: present = clear direct signal, absent = no direct machine instruction\n' +
    '- Structured metadata: OG tags, canonical, meta description — each adds readability\n' +
    '- Machine-readable entity definition: can the business be precisely described from evidence?\n' +
    '- Search visibility: how quickly does this business appear when searched?\n' +
    'Score tiers:\n' +
    '- Score 20-25: schema + llms.txt + complete metadata + strong search visibility\n' +
    '- Score 12-19: partial structured signals — OG tags present, some metadata, no schema\n' +
    '- Score 4-11: basic web presence, no schema, no llms.txt, limited metadata\n' +
    '- Score 0-3: no structured signals at all, or website inaccessible\n' +
    '- RULE: schema missing entirely = ease cannot exceed 8\n' +
    '- RULE: working website with OG tags but no schema = 4-7 range\n' +
    '- Required: state exactly which signals were found and which were absent\n\n' +

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
    'competitor.analysis must be 2-3 sentences minimum. It must answer:\\n' +
    '1. What specific advantage does this competitor have over the business?\\n' +
    '   (e.g. clearer positioning, stronger search visibility, better structured data,\\n' +
    '   more independent citations, stronger review presence)\\n' +
    '2. Where specifically does the comparison gap show up?\\n' +
    '   (e.g. at comparison stage, at automated procurement, at search discovery)\\n' +
    '3. What would the business need to close that gap?\\n' +
    'Do NOT write: \'Typically stronger in structured web presence\'.\\n' +
    'That is too vague. Be specific about what the competitor does better.\\n\\n' +

    'PLATFORM COVERAGE RULE:\n' +
    'Base coverage on evidence AND market position tier:\n' +
    '- present: business is clearly findable and citable on that platform from evidence\n' +
    '  OR marketPosition.tier is dominant or strong (well-known businesses are findable)\n' +
    '- weak: business appears in search results but lacks structured signals\n' +
    '  OR marketPosition.tier is upper_mid with some web presence\n' +
    '- absent: genuinely no evidence of presence — only for unknown or very new businesses\n' +
    'DO NOT mark all platforms absent for a business with 15+ years, named clients,\n' +
    'and confirmed web presence. Use weak as the floor for established businesses.\n\n' +

    'MARKET POSITION TIERS:\n' +
    'dominant, strong, upper_mid, mid, weak, absent\n\n' +

    'DECISION STATES:\n' +
    'not_seen, seen_not_considered, considered_not_chosen, trusted_not_chosen, chosen_by_default\n\n' +

    'SUMMARY PARAGRAPH — exactly 3 sentences:\n' +
    '- If tier is dominant or strong: start with "This business is currently chosen because..."\n' +
    '- If tier is upper_mid, mid, weak, absent: start with "This business is not the obvious choice because..."\n' +
    '- Sentence 2: the single strongest evidence-based driver or gap\n' +
    '- Sentence 3: the consequence for selection\n\n' +

        'CHOIVE LANGUAGE STANDARD:\n' +
    'CHOIVE explains why a business is easy or hard to select. Nothing more.\n' +
    'Every sentence must be immediately understandable. No jargon. No hype.\n\n' +

    'DO NOT USE:\n' +
    '- AI discovery, AI optimization, AI-friendly, AI ecosystems\n' +
    '- Cannot be found, completely missing, required for AI\n' +
    '- SEO, search optimization, digital marketing\n' +
    '- Vague abstractions: recommendation confidence environments, evaluation ecosystems\n\n' +

    'USE INSTEAD:\n' +
    '- Weak machine readability / limited structured data\n' +
    '- Harder to select under automated comparison\n' +
    '- Clear positioning / strong trust signals / well-defined entity\n' +
    '- Structurally preferred / easier to recommend with confidence\n' +
    '- Creates selection doubt / reduces selection friction\n\n' +

    'TONE: strategic, calm, precise, modern. Not alarming. Not generic.\n\n' +

    


    'PILLAR FINDINGS — each exactly 4-8 words, evidence-based, final tone.\n' +
    'PILLAR ANALYSIS — 1-2 sentences explaining the score with specific evidence.\n' +
    'PILLAR EVIDENCE — quote or reference the specific signal found or missing.\n\n' +

    'ACTION RULES:\\n' +
    'Every action must be SPECIFIC to this exact business — not generic advice.\\n' +
    'Reference actual evidence: quote the H1, name the missing signal, cite the exact gap found.\\n\\n' +
    'ACTION TITLE (3-6 words): specific, not generic.\\n' +
    'BAD: Add JSON-LD schema | GOOD: Define [business] as SoftwareApplication entity\\n\\n' +
    'ACTION BODY (max 20 words): name the gap and exact fix.\\n' +
    'BAD: Add schema for discoverability | GOOD: No JSON-LD found — add Organization + SoftwareApplication schema\\n\\n' +
    'ACTION EXPLANATION: what breaks if ignored, what improves if fixed — specific to this business.\\n' +
    'BAD: Essential for AI platforms | GOOD: Without this, comparison tools cannot categorize this vendor correctly\\n\\n' +

    'EVIDENCE NARRATIVE — 2-3 sentences: what was found, what was missing, what that means.\n\n' +

    'Return ONLY raw JSON. No markdown. No backticks. No explanation. Start with { end with }.\n\n' +

    '{\n' +
    '  "overallScore": 0,\n' +
    '  "inferredCategory": "",\n' +
    '  "verdictHeadline": "",\n' +
    '  "verdictLevel": "absent",\n' +
    '  "signatureLine": "",\n' +
    '  "decisionState": "",\n' +
    '  "decisionEnvironment": "",\n' +
    '  "summaryParagraph": "",\n' +
    '  "businessUnderstanding": "",\n' +
    '  "marketPosition": { "tier": "", "label": "", "explanation": "" },\n' +
    '  "pillars": {\n' +
    '    "clarity":    { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n' +
    '    "trust":      { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n' +
    '    "difference": { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n' +
    '    "ease":       { "score": 0, "finding": "", "analysis": "", "evidence": "" }\n' +
    '  },\n' +
    '  "platformCoverage": {\n' +
    '    "chatgpt":    { "status": "absent", "detail": "" },\n' +
    '    "perplexity": { "status": "absent", "detail": "" },\n' +
    '    "gemini":     { "status": "absent", "detail": "" },\n' +
    '    "claude":     { "status": "absent", "detail": "" }\n' +
    '  },\n' +
    '  "evidenceNarrative": "",\n' +
    '  "competitor": {\n' +
    '    "name": null,\n' +
    '    "domain": null,\n' +
    '    "analysis": null,\n' +
    '    "evidence": null,\n' +
    '    "queryContext": null\n' +
    '  },\n' +
    '  "actions": [\n' +
    '    { "priority": "critical", "title": "", "body": "", "explanation": "" },\n' +
    '    { "priority": "critical", "title": "", "body": "", "explanation": "" },\n' +
    '    { "priority": "high",     "title": "", "body": "", "explanation": "" },\n' +
    '    { "priority": "medium",   "title": "", "body": "", "explanation": "" }\n' +
    '  ]\n' +
    '}';
}

module.exports = { scoreWithClaude: scoreWithClaude, inferCategory: inferCategory };
