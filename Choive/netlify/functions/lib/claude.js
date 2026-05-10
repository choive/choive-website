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
  var competitorDomain   = evidence.competitorDomain   || '';
  var competitorPageText = evidence.competitorPageText || '';
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
    '\nINFERRED OFFICIAL SITE: ' + inferredSite +
    '\n\nKNOWLEDGE GRAPH:\n' + kgText +
    '\n\nWEBSITE CONTENT:\n' + websiteText +
    '\n\nSEARCH EVIDENCE (grouped by signal type):\n' + searchText +
    '\n\nCOMPETITORS APPEARING IN SEARCH:\n' + competitorText +
    (competitorPageText ? '\n\nCOMPETITOR PAGE FETCHED (' + competitorDomain + '):\n' + competitorPageText : '') +
    '\n\nSOCIAL PRESENCE DETECTED:\n' + socialText +
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
    '- Score 20+: multiple independent citations, reviews, partnerships confirmed\n' +
    '- Score 10-19: some third-party signals but limited\n' +
    '- Score 0-9: only owned channels, no independent confirmation\n' +
    '- Required: name the specific sources found (e.g. Trustpilot, press, directories)\n\n' +

    'DIFFERENCE (0-25): Can AI articulate why to choose this over alternatives?\n' +
    '- Score 20+: specific machine-readable differentiator present\n' +
    '- Score 10-19: differentiator implied but not clearly stated\n' +
    '- Score 0-9: generic, interchangeable positioning\n' +
    '- Required: quote the differentiator if found, or state why none was found\n\n' +

    'EASE (0-25): How technically ready is this business for AI selection?\n' +
    '- Score 20+: schema confirmed, llms.txt, structured data, complete OG tags\n' +
    '- Score 10-19: some structured signals present\n' +
    '- Score 0-9: no schema, no structured data detected\n' +
    '- RULE: if schema is missing entirely, ease cannot exceed 8\n' +
    '- Required: state exactly what structured signals were or were not found\n\n' +

    'COMPETITOR RULE:\n' +
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
    'based only on visible evidence — not assumptions about market position.\n\n' +

    'PLATFORM COVERAGE RULE:\n' +
    'Base coverage only on what the evidence shows:\n' +
    '- present: business is clearly findable and citable on that platform from evidence\n' +
    '- weak: business appears but with limited or inconsistent signals\n' +
    '- absent: no evidence of presence on that platform\n\n' +

    'MARKET POSITION TIERS:\n' +
    'dominant, strong, upper_mid, mid, weak, absent\n\n' +

    'DECISION STATES:\n' +
    'not_seen, seen_not_considered, considered_not_chosen, trusted_not_chosen, chosen_by_default\n\n' +

    'SUMMARY PARAGRAPH — exactly 3 sentences:\n' +
    '- If tier is dominant or strong: start with "This business is currently chosen because..."\n' +
    '- If tier is upper_mid, mid, weak, absent: start with "This business is not the obvious choice because..."\n' +
    '- Sentence 2: the single strongest evidence-based driver or gap\n' +
    '- Sentence 3: the consequence for selection\n\n' +

    'PILLAR FINDINGS — each exactly 4-8 words, evidence-based, final tone.\n' +
    'PILLAR ANALYSIS — 1-2 sentences explaining the score with specific evidence.\n' +
    'PILLAR EVIDENCE — quote or reference the specific signal found or missing.\n\n' +

    'ACTION BODIES — max 20 words, specific to this business, based only on missing evidence.\n' +
    'ACTION EXPLANATION — why this action matters for selection, based on evidence.\n\n' +

    'EVIDENCE NARRATIVE — 2-3 sentences: what was found, what was missing, what that means.\n\n' +

    'Return ONLY raw JSON. No markdown. No backticks. No explanation. Start with { end with }.\n\n' +

    '{\n' +
    '  "overallScore": 0,\n' +
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

module.exports = { scoreWithClaude: scoreWithClaude };
