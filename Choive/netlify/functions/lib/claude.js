// lib/claude.js
// CHOIVE™ evidence-first scoring engine
// Architecture: structured signals confirmed by engine → Claude analyzes → validators normalize
// ENV: ANTHROPIC_API_KEY

'use strict';

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS      = 240000; // scoring gets 4 min; the background function budget is 15
const MAX_TOKENS      = 4500;

function truncate(text, max) {
  max = max || 4000;
  var value = String(text || '');
  return value.length > max ? value.slice(0, max) : value;
}

// ── Sanitize external content against prompt injection ────────────────────────
function sanitizeExternal(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/gi, '[removed]')
    .replace(/forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/gi, '[removed]')
    .replace(/disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/gi, '[removed]')
    .replace(/you\s+are\s+now\s+(a\s+)?(different|new|another)/gi, '[removed]')
    .replace(/new\s+instructions?:/gi, '[removed]')
    .replace(/system\s*:\s*you\s+are/gi, '[removed]')
    .replace(/\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/g, '[removed]')
    .replace(/CHOIVE.*?score.*?must\s+be/gi, '[removed]')
    .replace(/set\s+(the\s+)?(overall|clarity|trust|difference|ease)\s+score\s+to/gi, '[removed]')
    .split('\n').map(function(line) {
      return line.replace(/\S{500,}/g, '[long-token-removed]');
    }).join('\n');
}

// ── Fast category inference ───────────────────────────────────────────────────
async function inferCategory(name, category, websiteText, searchText) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 15000);
  var prompt = 'Business name: ' + name + '\n'
    + 'User-provided category: ' + category + '\n'
    + 'Website content (excerpt): ' + String(websiteText || '').slice(0, 2000) + '\n'
    + 'Search evidence (excerpt): ' + String(searchText || '').slice(0, 2000) + '\n\n'
    + 'Based only on the evidence above, determine the precise real-world category this business operates in.\n'
    + 'Return ONLY a JSON object with one field:\n'
    + '{ "inferredCategory": "precise category name" }\n'
    + 'Be specific. Examples:\n'
    + '- Not "software" but "B2B OTT middleware platform for telcos and carmakers"\n'
    + '- Not "coffee" but "B2B specialty coffee roaster and wholesaler"\n'
    + 'CATEGORY FIDELITY \u2014 CRITICAL: when the business explicitly names its own category (in its title, H1, or self-description), USE ITS EXACT WORDS as the core of the category. Never substitute an adjacent industry\u2019s vocabulary: a business calling itself an "AI selection diagnostic" is NOT an "AI evaluation and benchmarking platform" \u2014 those are different markets with different buyers. Paraphrasing the category into a neighboring industry poisons every downstream measurement.\n'
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

// ── Build confirmed signals section for prompt ────────────────────────────────
function buildConfirmedSignals(websiteSignals) {
  if (!websiteSignals || Object.keys(websiteSignals).length === 0) {
    return 'CONFIRMED SIGNALS: Website not provided or not accessible.';
  }

  var s = websiteSignals;
  var lines = ['CONFIRMED SIGNALS (mechanically verified — treat as ground truth):'];

  lines.push('Title tag present: '        + (s.hasTitle           ? 'YES — "' + (s.titleText || '') + '"'  : 'NO'));
  lines.push('H1 present: '               + (s.hasH1              ? 'YES — "' + (s.h1Text    || '') + '"'  : 'NO'));
  lines.push('Meta description present: ' + (s.hasMetaDescription ? 'YES — "' + (s.metaDescriptionText || '').slice(0, 120) + '"' : 'NO'));
  lines.push('OG tags present: '          + (s.hasOgTags          ? 'YES' : 'NO'));
  lines.push('Canonical tag present: '    + (s.hasCanonical       ? 'YES' : 'NO'));

  if (s.hasSchema) {
    lines.push('Schema markup: YES (' + s.schemaCount + ' block(s)) — types: ' + (s.schemaTypes || []).join(', '));
    lines.push('Specific schema type: ' + (s.hasSpecificSchema ? 'YES' : 'NO — only generic types found'));
  } else {
    lines.push('Schema markup: NO — no JSON-LD detected');
    lines.push('Specific schema type: NO');
  }

  lines.push('llms.txt at domain root: ' + (s.hasLlmsTxt  ? 'YES (verified by direct fetch)' : 'NO'));
  lines.push('sitemap.xml accessible: '  + (s.hasSitemap  ? 'YES' : 'NO'));
  lines.push('robots.txt present: '      + (s.hasRobots   ? 'YES' : 'NO'));

  if (s.trustpilotReviewCount !== undefined) {
    lines.push('Trustpilot reviews (live): ' + s.trustpilotReviewCount + (s.trustpilotRating ? ' — rating ' + s.trustpilotRating : ''));
  }
  if (s.googleReviewCount !== undefined) {
    lines.push('Google reviews (live): ' + s.googleReviewCount + (s.googleRating ? ' — rating ' + s.googleRating : ''));
  }

  if (s.confirmedReviewPlatforms && s.confirmedReviewPlatforms.length > 0) {
    lines.push('Review platform pages fetched: ' + s.confirmedReviewPlatforms.join(', '));
  }

  return lines.join('\n');
}

// ── Main scoring prompt ───────────────────────────────────────────────────────
function buildPrompt(evidence) {
  var name               = evidence.name        || '';
  var category           = evidence.category    || '';
  var city               = evidence.city        || '';
  var website            = evidence.website     || 'not provided';
  var description        = evidence.description || 'not provided';
  var inferredSite       = evidence.inferredOfficialSite || 'not found';
  var websiteText        = sanitizeExternal(truncate(evidence.websiteText, 3000))  || 'No website content available.';
  var searchText         = sanitizeExternal(truncate(evidence.searchText, 5000))   || 'No search results returned.';
  var kgText             = sanitizeExternal(truncate(evidence.kgText, 1200))       || 'None';
  var visibilityPosition = evidence.visibilityPosition;
  var competitors        = evidence.competitors        || [];
  var knownCompetitors   = evidence.knownCompetitors   || '';
  var competitorDomain   = evidence.competitorDomain   || '';
  var competitorPageText = evidence.competitorPageText || '';
  var previousCompetitor = sanitizeExternal(String(evidence.previousCompetitor || '')).trim();

  // AI SELECTION GROUND TRUTH — the three real recommendation queries run in
  // Stage 1c. The businesses named in these responses are who AI actually
  // recommends today; they are the primary source for competitor selection.
  var simBefore = evidence.aiSimulationBefore || null;
  var simGroundTruth = '';
  if (simBefore && simBefore.before && Array.isArray(simBefore.before.results)) {
    simGroundTruth = simBefore.before.results.map(function(r, i) {
      return 'QUERY ' + (i + 1) + ' (' + String(r.label || '') + '): "' + String(r.query || '') + '"\n'
        + 'AI ANSWERED: ' + sanitizeExternal(String(r.response || ''));
    }).join('\n\n');
  }
  var socialText         = sanitizeExternal(evidence.socialText || 'No social media pages found.');
  var reviewText         = sanitizeExternal(evidence.reviewText || 'No review platform pages found.');
  var apifyText          = sanitizeExternal(evidence.apifyText  || '');
  var socialSignals      = evidence.socialSignals || {};
  var summaries          = evidence.summaries     || {};
  var websiteSignals     = evidence.websiteSignals || {};

  var competitorText = competitors.length > 0
    ? competitors.map(function(c) {
        var tag = c.isLocal ? ' [found via local-market search — likely a local/domestic competitor]' : '';
        return '- ' + c.domain + tag + ': ' + (c.snippet || '');
      }).join('\n')
    : 'No clear competitors identified in search results.';

  var socialList    = Object.keys(socialSignals).filter(function(k) { return socialSignals[k]; });
  var socialDisplay = socialList.length > 0 ? socialList.join(', ') : 'None detected in search results.';

  var visibilityText = (visibilityPosition !== undefined && visibilityPosition !== -1)
    ? 'YES (position ' + (visibilityPosition + 1) + ')'
    : 'NO';

  var confirmedSignalsSection = buildConfirmedSignals(websiteSignals);

  var prompt = 'BUSINESS:\n'
    + 'Name: ' + name + '\n'
    + 'Category: ' + category + '\n'
    + 'Location: ' + city + '\n'
    + 'Website: ' + website + '\n'
    + 'Description: ' + description + '\n'
    + (knownCompetitors ? '\nKNOWN COMPETITORS (provided by user): ' + knownCompetitors + '\n' : '')
    + '\nINFERRED OFFICIAL SITE: ' + inferredSite
    + '\n\n' + confirmedSignalsSection
    + '\n\nKNOWLEDGE GRAPH:\n' + kgText
    + '\n\nWEBSITE CONTENT:\n' + websiteText
    + '\n\nSEARCH EVIDENCE (grouped by signal type):\n' + searchText
    + '\n\nCOMPETITORS APPEARING IN SEARCH:\n' + competitorText
    + (competitorPageText ? '\n\nCOMPETITOR PAGE FETCHED (' + competitorDomain + '):\n' + competitorPageText : '')
    + (previousCompetitor ? '\n\nPREVIOUSLY VERIFIED COMPETITOR (identified in the last completed diagnostic of this exact business): ' + previousCompetitor : '')
    + (evidence.competitorDecision ? '\n\nCOMPETITOR DECISION \u2014 MADE BY THE DEDICATED SELECTION STAGE (do not override):\n'
        + (evidence.competitorDecision.realCompetitor
            ? 'competitors[0].name MUST be exactly: ' + evidence.competitorDecision.realCompetitor + ' \u2014 the subject\u2019s true head-to-head market rival (source: ' + evidence.competitorDecision.source + '). Reason: ' + evidence.competitorDecision.reason + ' Its evidence text MUST state honestly whether the AI SELECTION GROUND TRUTH currently names this rival, quoting what AI answered instead if it does not.'
            : 'No true head-to-head rival could be named with confidence \u2014 apply the normal fallback rules for competitors[0].')
        + (evidence.competitorDecision.aiRecommends && evidence.competitorDecision.aiRecommends !== evidence.competitorDecision.realCompetitor
            ? ' competitors[1] MUST be: ' + evidence.competitorDecision.aiRecommends + ' \u2014 the business AI actually recommends for these queries today; label its queryContext accordingly and ground its entry in the AI SELECTION GROUND TRUTH.'
            : '')
        + (evidence.competitorDecision.globalBenchmark && evidence.competitorDecision.globalBenchmark !== evidence.competitorDecision.realCompetitor
            ? ' competitors[2] MAY be: ' + evidence.competitorDecision.globalBenchmark + ' \u2014 the international category leader; label it explicitly as a global benchmark that does NOT serve this market: a playbook to study, not a rival taking these customers.'
            : '')
        + ' If the owner named competitors in their input and none of them appears in the competitors array, one slot (preferring [2] over the global benchmark) MUST address the most significant owner-named competitor honestly: state plainly whether the AI SELECTION GROUND TRUTH mentions them, and how their confirmed signals compare to the subject\u2019s. The owner asked about this business \u2014 the report must answer.'
        + (evidence.competitorDecision.categoryUnowned
            ? ' The ground truth names no true same-category player \u2014 the category answer is UNOWNED; state this as an opportunity in the competitor narrative.'
            : '')
        : '')
    + (simGroundTruth ? '\n\nAI SELECTION GROUND TRUTH — three real AI recommendation queries were run for this business\u2019s category and location, in the market\u2019s own language where applicable. The businesses named below are who AI ACTUALLY recommends today:\n' + simGroundTruth : '')
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
    + 'YOU ARE CHOIVE™ — A DECISION INTELLIGENCE ENGINE.\n\n'
    + 'YOUR ONLY JOB:\n'
    + 'Determine why a customer would or would not choose this business over alternatives.\n\n'
    + 'CRITICAL — CONFIRMED SIGNALS ARE GROUND TRUTH:\n'
    + 'The CONFIRMED SIGNALS section above was produced by mechanical verification — direct HTTP\n'
    + 'requests, HTML parsing, file checks. These facts are certain. Do not contradict them.\n'
    + 'When scoring Clarity and Ease, your scores MUST reflect what the confirmed signals show:\n'
    + '- If "Schema markup: YES" → ease score cannot be below 12\n'
    + '- If "Schema markup: NO" → ease score cannot exceed 8\n'
    + '- If "llms.txt: YES" → ease score cannot be below 18\n'
    + '- If "Title tag: YES" and "H1: YES" and "Meta description: YES" → clarity cannot be below 14\n'
    + '- If "Title tag: NO" and "H1: NO" → clarity cannot exceed 8\n'
    + 'These are not suggestions. They are hard constraints derived from real data.\n\n'
    + 'STRICT RULES:\n'
    + '1. Use ONLY the evidence provided above. No prior knowledge. No assumptions.\n'
    + '2. Every score must be justified by specific evidence.\n'
    + '3. If a signal is missing, say it is missing. Do not invent it.\n'
    + '4. Every pillar finding must quote or directly reference specific evidence.\n'
    + '5. If an AI SELECTION GROUND TRUTH section is present, prefer a business named in those AI responses — but ONLY if it is genuinely in the same category serving the same buyer at the same deal size. If no ground-truth name qualifies (AI often answers new categories with adjacent giants from other industries — those are NOT competitors), select from the search evidence instead. If neither yields one, return null.\n'
    + '6. CRITICAL: It is NOT the same business being diagnosed — never name the subject business or any variation of its name as a competitor\n'
    + '7. CRITICAL: It is NOT a platform, tool, or service that this business measures, diagnoses, audits, or helps businesses appear on — for example, if this business helps clients appear on ChatGPT, then ChatGPT is not a competitor; it is the platform being measured\n'
    + 'STEP 0 — INFER REAL CATEGORY FROM EVIDENCE:\n'
    + 'User provided category: "' + category + '" — this may be vague or incorrect.\n'
    + 'Using ONLY the evidence, determine:\n'
    + '1. What does this business actually sell?\n'
    + '2. Who buys it — consumer, SMB, enterprise, telco, automotive?\n'
    + '3. What precise industry category would buyers use to find this?\n'
    + '4. B2B, B2C, or both?\n'
    + 'Set inferredCategory in the JSON. Do not write this as prose.\n\n'
    + 'DECISION ENVIRONMENT — classify first:\n'
    + '- discovery_driven: local, map-based, search-based selection\n'
    + '- comparison_driven: evaluated against alternatives before decision\n'
    + '- authority_driven: selected based on reputation, partnerships, capability\n'
    + '- default_driven: category leader chosen automatically\n\n'
    + 'SCORING — four pillars, each 0-25:\n\n'
    + 'CLARITY (0-25): How precisely and consistently is this business defined?\n'
    + '- Score 20+: specific H1, clear category, consistent naming across all sources\n'
    + '- Score 10-19: partially defined, some inconsistency\n'
    + '- Score 0-9: vague, inconsistent, or undefined\n'
    + '- HARD CONSTRAINT: If confirmed signals show Title YES + H1 YES + Meta YES → minimum 14\n'
    + '- HARD CONSTRAINT: If confirmed signals show Title NO + H1 NO → maximum 8\n'
    + '- Required: quote the actual H1 or description found in confirmed signals\n\n'
    + 'TRUST (0-25): How much independent third-party verification exists?\n'
    + '- Score 20-25: multiple strong independent citations — press, reviews, partnerships all confirmed\n'
    + '- Score 15-19: solid third-party signals — named client testimonials from known companies,\n'
    + '  OR verified review platform presence with ratings, OR confirmed press coverage\n'
    + '- Score 8-14: some third-party signals but limited — one or two sources only\n'
    + '- Score 0-7: only owned channels, no independent confirmation found\n'
    + '- RULE: named executive testimonials from Fortune 500 or major enterprise clients\n'
    + '  with full name and title count as strong trust signals — score minimum 15\n'
    + '- RULE: global top-tier firms (Magic Circle law, Big Four accounting) = minimum 16\n'
    + '- RULE: Legal 500 or Chambers rankings count as strong independent citations\n'
    + '- RULE: for consumer brands, use exact review numbers from CONFIRMED SIGNALS if present\n'
    + '  330 Facebook likes + 1 review = score 4-6. 50+ Trustpilot reviews = score 14+\n'
    + '- Required: name specific sources AND exact numbers\n\n'
    + 'TRUST ACTION RULE:\n'
    + 'When trust is low, action body must state:\n'
    + '1. Exactly what was found\n'
    + '2. The number needed to be credible in this category\n'
    + '3. The specific platform that matters most for this buyer type\n\n'
    + 'DIFFERENCE (0-25): Can someone explain why to choose this over alternatives?\n'
    + '- Score 20-25: specific, unique differentiator clearly stated and easy to repeat\n'
    + '- Score 15-19: real differentiator visible — named niche, named enterprise clients, unique use case\n'
    + '- Score 8-14: differentiator exists but vague or easy to copy\n'
    + '- Score 0-7: completely generic — no niche, no unique clients, no distinct use case\n'
    + '- CRITICAL: a business with named automotive partnerships (Škoda, Zeekr, Geely)\n'
    + '  AND named telco clients (TELUS, Proximus) AND 15+ years in a niche CANNOT score below 14\n'
    + '- Required: quote the actual differentiator, or state precisely why none exists\n'
    + '- DIFFERENCE FINDING FORMAT: complete this sentence — "[Business] is the [specific thing] for [specific buyer]"\n'
    + '  If no differentiator exists, complete: "[Business] looks like every other [category] to a buyer"\n'
    + '- Analysis sentence 1: Quote the exact phrase or evidence that shows the differentiator (or its absence)\n'
    + '- Analysis sentence 2: Name the exact sales conversation moment where this difference is won or lost\n\n'
    + 'EASE (0-25): How quickly and confidently can this business be understood and selected?\n'
    + '- Score 20-25: schema + llms.txt + complete metadata + strong search visibility\n'
    + '- Score 14-19: schema present + complete metadata but no llms.txt\n'
    + '- Score 8-13: partial structured signals — OG tags + some metadata, no schema\n'
    + '- Score 4-7: basic web presence — website works, OG tags present, no schema, no llms.txt\n'
    + '- Score 0-3: no structured signals at all, or website inaccessible\n'
    + '- HARD CONSTRAINT: confirmed "Schema markup: YES" → score MINIMUM 12\n'
    + '- HARD CONSTRAINT: confirmed "Schema markup: NO" → score MAXIMUM 8\n'
    + '- HARD CONSTRAINT: confirmed "llms.txt: YES" → score MINIMUM 18\n'
    + '- Required: state exactly which signals were confirmed and which were absent\n\n'
    + 'COMPETITOR RULE — SOURCE PRIORITY:\n'
    + 'PRIORITY 1 — AI SELECTION GROUND TRUTH: if the evidence contains an AI SELECTION GROUND TRUTH section, the dominant competitor (competitors[0], the business shown as \u201cAI is recommending instead of you\u201d) MUST be a business named in those AI responses THAT ALSO PASSES EVERY exclusion criterion below — same category, same buyer type, same deal size, not a directory, not the subject business, not a measured platform. Among qualifying names, choose the most prominently recommended — a top pick outranks a list mention; more mentions outrank fewer. The qualifying ground truth OUTRANKS the previously verified competitor: if they disagree, follow the ground truth — this is how past mis-identifications are corrected. Additional competitors (competitors[1..2]) MAY come from search evidence as structural benchmarks.\n'
    + 'COMPETITOR CONTINUITY: if a PREVIOUSLY VERIFIED COMPETITOR is provided and that business ALSO appears anywhere in the current qualifying ground truth, KEEP it as competitors[0] — even if another qualifying name is marginally more prominent this run. Switch the dominant competitor ONLY when the previous one is absent from the current ground truth, or another business is now clearly the top recommendation across multiple queries. The dominant competitor is a stable identity, not a coin flip between near-equals.\n'
    + 'GROUND TRUTH DISQUALIFICATION: if NO business named in the ground truth passes the criteria — common when the category is new and AI answers with adjacent giants from other categories — do NOT force one in. Treat the ground truth as empty for competitor selection, select under PRIORITY 2 instead, and set the competitor queryContext to note that AI currently names no true same-category player for these queries — the category is unowned, which is an opportunity.\n'
    + 'PRIORITY 2 — SEARCH EVIDENCE: if no AI SELECTION GROUND TRUTH section exists, or no ground-truth name qualifies, select from search evidence under the rule below.\n'
    + 'In BOTH cases every exclusion criterion below still applies.\n'
    + 'Only name a competitor if ALL of these are true:\n'
    + '1. The competitor name appears in the AI SELECTION GROUND TRUTH responses or in the search evidence above\n'
    + '2. It is in the exact same category as this business\n'
    + '3. It competes for the same buyer type at the same deal size\n'
    + '4. It is not a directory, review platform, aggregator, or listing site\n'
    + '5. It would realistically appear in the same sales conversation\n'
    + '6. CRITICAL: It is NOT the same business being diagnosed — never name the subject business or any variation of its name as a competitor\n'
    + '7. CRITICAL: It is NOT a platform, tool, or service that this business measures, diagnoses, audits, or helps businesses appear on — for example, if this business helps clients appear on ChatGPT, then ChatGPT is not a competitor; it is the platform being measured\n'
    + 'If no competitor meets all 6 criteria from search evidence, do this fallback:\n'
    + '  Use your knowledge of the INFERRED CATEGORY to name the most well-known player in that space.\n'
    + '  Set queryContext to "category-based analysis" and evidence to "Named based on category knowledge — not found in search evidence."\n'
    + '  Only return null if the business is in a completely unique category with no comparable players anywhere.\n\n'
    + (knownCompetitors ? ('IF THE USER PROVIDED KNOWN COMPETITORS:\n'
    + 'It is verified ground truth from the business owner. For each name in that list:\n'
    + '1. Search the evidence above for any mention of that name, even a brief one.\n'
    + '2. If found anywhere in the evidence, include it as a competitor.\n'
    + '3. A user-provided name found in evidence takes priority over unnamed competitors.\n'
    + '4. If none of the user-provided names appear in evidence, do not invent evidence for them.\n\n') : '')
    + 'SCAN ALL EVIDENCE — DO NOT STOP AT THE FIRST MATCH:\n'
    + 'If TWO OR MORE distinct competitor names meeting all 6 criteria appear ANYWHERE in the evidence,\n'
    + 'return all of them (up to 3). Returning only 1 when 2+ exist is an incomplete answer.\n\n'
    + 'CATEGORY PRIORITY:\n'
    + 'The evidence contains two passes of search results.\n'
    + 'The SECOND-PASS results (labelled "SECOND-PASS COMPETITOR SEARCH") used the REAL inferred category — these are more accurate than first-pass results.\n'
    + 'If a competitor appears in second-pass results, ALWAYS prefer them over first-pass results.\n'
    + 'First-pass competitors should only be used if no second-pass competitors exist.\n\n'
    + (previousCompetitor ? ('COMPETITOR STABILITY \u2014 PREVIOUSLY VERIFIED COMPETITOR:\n'
    + 'A previous completed diagnostic of this exact business identified "' + previousCompetitor + '" as the primary competitor.\n'
    + 'Treat this as a strong prior. If "' + previousCompetitor + '" still meets ALL competitor criteria above, keep it as the FIRST competitor in your list.\n'
    + 'Only replace it as primary if the current evidence clearly shows it no longer qualifies (wrong category, not a genuine competitor, or directly contradicted by evidence).\n'
    + 'Do not swap the primary competitor between runs without a clear evidence-based reason \u2014 stability matters more than novelty.\n'
    + 'NEVER mention this rule, the phrase \"previously verified\", or prior diagnostics in any output field \u2014 output text must read as a fresh assessment.\n\n') : '')
    + 'GEOGRAPHIC COVERAGE:\n'
    + 'Return UP TO 3 competitors. Target shape:\n'
    + '- One LOCAL or DOMESTIC competitor (same country/region)\n'
    + '- One INTERNATIONAL or GLOBAL competitor (different country, same category)\n'
    + 'Entries tagged "[found via local-market search]" are your first choice for the local slot.\n'
    + 'Do not invent a local competitor if none appears in evidence.\n\n'
    + 'SOURCE QUALITY — PREFER GENUINE OVER GENERIC:\n'
    + 'HIGH QUALITY: named alongside this business in a news article, industry panel, analyst report.\n'
    + 'LOWER QUALITY: appears on a generic "best X vendors" / "top X alternatives" listicle site.\n'
    + 'If both types exist, use the press-named one first.\n\n'
    + 'IF A COMPETITOR HAS REBRANDED:\n'
    + 'Use the CURRENT name only. You may mention the former name once in the evidence field.\n\n'
    + 'COMPETITOR ANALYSIS DEPTH:\n'
    + 'advantage: one sentence — what specific structural or positioning advantage do they have?\n'
    + 'gapLocation: one sentence — at what exact point in selection does this hurt the business?\n'
    + 'closeGap: one sentence — what single specific change would close this gap?\n'
    + 'Format: "[Business] should [exact action] so that [buyer outcome]."\n\n'
    + 'PLATFORM COVERAGE RULE:\n'
    + '- present: clearly findable OR marketPosition.tier is dominant\n'
    + '- weak: appears in search results but lacks structured signals OR tier is strong\n'
    + '- absent: genuinely no evidence — only for unknown or very new businesses\n'
    + '- RULE: dominant tier = PRESENT on all platforms. No exceptions.\n'
    + '- RULE: strong tier = minimum WEAK on all platforms.\n\n'
    + 'MARKET POSITION TIERS:\n'
    + 'dominant: household name globally — Nike, Starbucks, Salesforce, McKinsey, Freshfields\n'
    + '  Magic Circle law firms = dominant. Big Four accounting = dominant.\n'
    + 'strong: well-known in category — named by buyers without prompting.\n'
    + 'upper_mid: known within category but requires some discovery.\n'
    + 'mid: present but requires active search. Regional or niche B2B player.\n'
    + 'weak: limited presence — hard to find without knowing the name.\n'
    + 'absent: no detectable presence in evidence.\n'
    + 'CRITICAL TIER RULES:\n'
    + '- A B2B niche vendor with Fortune 500 clients = mid or upper_mid, NOT strong or dominant\n'
    + '- Strong/dominant = known by buyers WITHOUT being searched for\n'
    + '- Technical gaps do NOT lower tier. Tier = real-world selection likelihood.\n'
    + '- When uncertain: use the lower tier\n\n'
    + 'CHOIVE LANGUAGE STANDARD:\n'
    + 'WHAT CHOIVE IS: A business selection diagnostic. Why a business is chosen, overlooked, trusted, compared, or ignored.\n'
    + 'NOT an SEO audit. NOT an AI visibility tool. Focus on SELECTION.\n'
    + 'NEVER WRITE: AI cannot understand / AI does not know / AI cannot categorize\n'
    + 'INSTEAD WRITE: not consistently selected / recommendation confidence low / selection friction exists\n'
    + 'TRUST: Named Fortune 500 clients, partnerships, long history = HIGH TRUST. Review volume alone is not trust.\n'
    + 'EASE: How quickly understood, categorized, selected. Schema is one factor, not the whole score.\n'
    + 'COMPETITORS: Only from evidence. Never invent. If none found: No dominant comparison pattern detected.\n'
    + 'RECOMMENDATIONS: Explain outcome not task.\n'
    + 'TONE: Strategic advisor.\n\n'
    + 'ACTION RULES:\n'
    + '- Actions must be specific to this business — name the business, name the platform, name the exact gap\n'
    + '- Body sentence 1: what is missing right now, with specific evidence cited — name the exact number, platform, or signal\n'
    + '- Body sentence 2: exactly what to do — one action, one platform, one outcome. Start with a verb.\n'
    + '- Explanation: the selection consequence — what changes for the buyer when this is fixed\n'
    + '  Do NOT explain the technical task. Explain what the buyer experiences differently.\n'
    + '  Format: "When [this is done], [buyer] will [specific outcome] instead of [current problem]."\n'
    + '- if_nothing: one sentence — what happens to this business in 90 days if this action is not taken.\n'
    + '  Format: "Without this, [specific competitive consequence]."\n'
    + '- TITLE BANNED WORDS: schema, schema markup, JSON-LD, llms.txt, metadata, canonical — never in title\n'
    + '- TITLE GOOD: Get your first independent review, Close the comparison gap, Define your business for AI systems\n'
    + '- Body/explanation use: structured presence, machine-readable definition, comparison signals\n'
    + '- BANNED WORDS — NEVER use in action title OR body: JSON-LD, schema markup, metadata, canonical, llms.txt\n'
    + '- NEVER give generic actions. Every action must be impossible to give to a different business.\n'
    + '- SEQUENCE: actions must be ordered by what unlocks what — fixing trust before ease, clarity before difference\n'
    + '- REAL ENTITIES ONLY: never name a company, platform, or service in actions or plans unless you are confident it is currently operating. If an entity from search evidence may be defunct or unrecognisable, omit the name entirely.\n\n'
    + 'PILLAR FINDINGS — USE THESE EXACT FORMATS:\n'
    + 'Clarity finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Trust finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Difference finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Ease finding: [one short phrase, max 6 words, no punctuation]\n\n'
    + 'PILLAR ANALYSIS — exactly 2 sentences each:\n'
    + 'Sentence 1: Quote or directly reference the specific evidence. Name exact numbers, platforms, signals found or missing.\n'
    + 'Sentence 2: State the exact selection consequence — what a buyer experiences because of this score.\n'
    + 'NEVER write generic analysis. Every sentence must be impossible to apply to a different business.\n\n'
    + 'VERDICT HEADLINE — max 10 words, no punctuation, strategic advisor tone\n\n'
    + 'SUMMARY PARAGRAPH — exactly 3 sentences:\n'
    + '- If tier is dominant or strong: start with "This business is currently chosen because..."\n'
    + '- If tier is upper_mid, mid, weak, absent: start with "This business is not the obvious choice because..."\n'
    + '- Sentence 2: the single strongest evidence-based driver or gap\n'
    + '- Sentence 3: the concrete moment in the buyer journey where this business is lost or won.\n'
    + '  Name the exact moment. Do not invent statistics.\n\n'
    + 'BUSINESS UNDERSTANDING — what AI currently thinks this business is:\n'
    + 'Write exactly two paragraphs separated by a blank line.\n'
    + 'Paragraph 1 — BEFORE: Write the exact paragraph an AI would generate TODAY if asked to describe this business.\n'
    + '  Use only signals visible in the evidence. Start with the business name.\n'
    + '  Be honest — if signals are weak, the paragraph will be vague. If strong, it will be specific.\n'
    + 'Paragraph 2 — AFTER: Write what that same AI paragraph would say after the top fixes are implemented.\n'
    + '  Start with the business name. Reference ONLY the concrete fixes from your own actions list\n'
    + '  (e.g. verified reviews on the named platform, llms.txt present, schema confirmed).\n'
    + '  NEVER invent press coverage, publications, client names, awards, or partnerships.\n'
    + '  NEVER use bracket placeholders like [platform] or [publication] — name the real platform from your actions or omit it.\n'
    + '  Phrase it as what AI would say once those specific fixes are verifiably in place. Nothing beyond them.\n'
    + '  The contrast between the two paragraphs is the core value of this field.\n\n'
    + 'EVIDENCE NARRATIVE RULES:\n'
    + 'Write exactly what was found and what was not found. Name specific search queries that returned zero results.\n'
    + 'Name specific signals that were confirmed. Name the exact gap between what exists and what is needed.\n'
    + 'Do not summarise. Do not soften. Do not generalise. Every sentence must be evidence-backed.\n\n'
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
    + (evidence.competitorDecision && evidence.competitorDecision.realCompetitor ? '  REMINDER: competitors[0].name must be exactly "' + evidence.competitorDecision.realCompetitor + '".\n' : '')
    + '  "competitors": [\n'
    + '    { "name": "", "advantage": "", "gapLocation": "", "closeGap": "", "evidence": "", "queryContext": "search" }\n'
    + '  ],\n'
    + '  "actions": [\n'
    + '    { "priority": "critical", "title": "", "body": "", "explanation": "", "if_nothing": "" },\n'
    + '    { "priority": "critical", "title": "", "body": "", "explanation": "", "if_nothing": "" },\n'
    + '    { "priority": "high",     "title": "", "body": "", "explanation": "", "if_nothing": "" },\n'
    + '    { "priority": "medium",   "title": "", "body": "", "explanation": "", "if_nothing": "" }\n'
    + '  ]\n'
    + '}';

  return prompt + jsonSchema;
}

// ── Parse Claude response ─────────────────────────────────────────────────────
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
  var start = clean.indexOf('{');
  var end   = clean.lastIndexOf('}');
  if (start > 0) { console.log('[CHOIVE] Non-JSON prefix:', JSON.stringify(clean.slice(0, Math.min(start, 100)))); }
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }
  console.error('[CHOIVE] Claude parse failed. Raw start:', text.slice(0, 300));
  console.error('[CHOIVE] Claude parse failed. Raw end:', text.slice(-300));
  throw new Error('Could not parse Claude response as JSON');
}

// ── Apply hard score constraints from confirmed signals ───────────────────────
function applySignalConstraints(rawOutput, websiteSignals) {
  if (!websiteSignals || Object.keys(websiteSignals).length === 0) return rawOutput;
  var s = websiteSignals;
  var p = rawOutput.pillars || {};

  if (p.ease) {
    var ease = Number(p.ease.score) || 0;
    if (s.hasLlmsTxt  && ease < 18) { p.ease.score = Math.max(ease, 18); }
    if (s.hasSchema   && ease < 12) { p.ease.score = Math.max(ease, 12); }
    if (!s.hasSchema  && ease >  8) { p.ease.score = Math.min(ease,  8); }
  }

  if (p.clarity) {
    var clarity = Number(p.clarity.score) || 0;
    if (s.hasTitle && s.hasH1 && s.hasMetaDescription && clarity < 14) {
      p.clarity.score = Math.max(clarity, 14);
    }
    if (!s.hasTitle && !s.hasH1 && clarity > 8) {
      p.clarity.score = Math.min(clarity, 8);
    }
  }

  var cs = Number(p.clarity    && p.clarity.score)    || 0;
  var ts = Number(p.trust      && p.trust.score)      || 0;
  var ds = Number(p.difference && p.difference.score) || 0;
  var es = Number(p.ease       && p.ease.score)       || 0;
  rawOutput.overallScore = cs + ts + ds + es;

  return rawOutput;
}

// ── Safe output normalizer ────────────────────────────────────────────────────
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

// ── Main scoring function ─────────────────────────────────────────────────────
// ── DEDICATED COMPETITOR SELECTION STAGE ─────────────────────────────────────
// Competitor identity is too important to be one rule inside the giant scoring
// prompt (where converging priors caused wrong-competitor lock-in). This small
// single-purpose call decides the dominant competitor; the scoring prompt then
// receives the decision as fact. Fails soft: on any error, returns null and the
// scoring prompt's own rules apply as before.
async function selectDominantCompetitor(evidence) {
  var name       = String(evidence.name || '').trim();
  var category   = String(evidence.category || '').trim();
  var inferred   = String(evidence.inferredCategory || category).trim();
  var previous   = sanitizeExternal(String(evidence.previousCompetitor || '')).trim();
  var known      = String(evidence.knownCompetitors || '').trim();
  var summary    = String((evidence.summaries || {}).businessSummary || '').slice(0, 600);
  var website    = String(evidence.website || '').trim();
  var city       = String(evidence.city || '').trim();

  var simBefore = evidence.aiSimulationBefore || null;
  var groundTruth = '';
  if (simBefore && simBefore.before && Array.isArray(simBefore.before.results)) {
    groundTruth = simBefore.before.results.map(function(r, i) {
      return 'QUERY ' + (i + 1) + ': "' + String(r.query || '') + '"\nAI ANSWERED: '
        + sanitizeExternal(String(r.response || '')).slice(0, 900);
    }).join('\n\n');
  }
  var searchComps = (evidence.competitors || []).map(function(c) {
    return String(c.name || c.domain || '');
  }).filter(Boolean).slice(0, 6).join(', ');

  var prompt = 'You identify competitors for a business diagnostic. Respond ONLY with a JSON object, no markdown, no preamble.\n\n'
    + 'SUBJECT BUSINESS: ' + name + (website ? ' (' + website + ')' : '') + '\n'
    + 'CATEGORY: ' + inferred + '\n'
    + (city ? 'MARKET / LOCATION: ' + city + '\n' : '')
    + (summary ? 'WHAT IT DOES: ' + summary + '\n' : '')
    + (known ? 'COMPETITORS NAMED BY THE OWNER (highest-truth source): ' + known + '\n' : '')
    + (previous ? 'PREVIOUS RUN COMPETITOR (continuity hint only \u2014 NOT verified truth; discard if it fails the tests): ' + previous + '\n' : '')
    + (groundTruth ? '\nAI SELECTION GROUND TRUTH \u2014 what AI actually recommended when asked for this category:\n' + groundTruth + '\n' : '')
    + (searchComps ? '\nCOMPETITORS FOUND IN SEARCH EVIDENCE: ' + searchComps + '\n' : '')
    + '\nProduce TWO answers:\n\n'
    + 'ANSWER A \u2014 realCompetitor: the subject\u2019s TRUE head-to-head market rival \u2014 the company a knowledgeable buyer or the owner would name as the direct alternative in a deal. Source priority: (1) owner-named competitors, (2) your own industry knowledge of this niche \u2014 you MAY use it here; direct-competitor relationships are stable public facts and this is the one place prior knowledge is required. Ask yourself: if a knowledgeable local buyer \u2014 or an AI assistant \u2014 were asked \u201cwho is ' + name + '\u2019s direct competitor?\u201d, which real company would they name? That company, market-verified, is the answer, (3) names in the evidence. Requirements: same category, same buyer type, comparable deal size, AND SAME SERVICEABLE MARKET \u2014 a business the subject\u2019s own customers could actually buy from instead. A company that does not sell, ship, or operate where the subject\u2019s customers are FAILS this test no matter how similar the product (a US-only meat brand is NOT the rival of a Germany-only meat brand; a Switzerland-only delivery service is NOT the rival of a business selling to German customers). MARKET CONFIDENCE RULE: if you are not CONFIDENT a candidate actually sells or delivers to the subject\u2019s market, it FAILS \u2014 uncertainty disqualifies, never the reverse. A real, currently operating company you are confident exists; never a directory, aggregator, or adjacent giant from another industry (e.g. a data-labeling company is NOT a rival to an AI-visibility tool); never the subject or a name variant. CONTINUITY COMES FIRST: the head-to-head rival is a stable market fact, not a daily poll. If a previous-run competitor is provided, first verify it against ALL the requirements above \u2014 including the market test with the same confidence rule. If it passes, KEEP IT as realCompetitor \u2014 even if other names are more prominent in today\u2019s AI answers. Replace it ONLY if: it fails the requirements (wrong market, defunct, wrong buyer), the owner has named different competitors, or the evidence clearly shows another company has displaced it as the market\u2019s primary head-to-head over time \u2014 never because of one run\u2019s mention counts. A previous competitor that FAILS the market test is a leftover from an earlier mis-selection \u2014 discard it entirely and select fresh; do not let a poisoned prior anchor the decision. If you cannot name a real head-to-head rival with confidence, return null rather than guessing.\n\n'
    + 'ANSWER B \u2014 aiRecommends: from the AI SELECTION GROUND TRUTH only \u2014 the real business AI recommended most prominently (top pick > list mention; more mentions > fewer), excluding the subject. This is a factual reading of the responses, NOT a judgment of fair rivalry. null if no ground truth or no real business is named.\n\n'
    + 'ANSWER C \u2014 globalBenchmark: only if realCompetitor is regional and a clearly larger INTERNATIONAL category leader exists that does NOT serve the subject\u2019s market \u2014 name it as the global benchmark worth studying. Otherwise null.\n\n'
    + 'Also report categoryUnowned: true if NO business in the ground truth is genuinely in the subject\u2019s category (AI answered with adjacent players) \u2014 meaning the category answer is unowned.\n\n'
    + 'Respond with exactly: {"realCompetitor": <name or null>, "aiRecommends": <name or null>, "globalBenchmark": <name or null>, "source": "owner" | "industry_knowledge" | "evidence" | "continuity" | "none", "categoryUnowned": <true|false>, "reason": "<one sentence on why realCompetitor is the true rival>"}';

  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 40000);
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
        max_tokens: 350,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    var data = await res.json();
    var text = (data.content || []).filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; }).join('').replace(/```json|```/g, '').trim();
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    function cleanName(v) {
      var s = v ? String(v).trim() : '';
      if (!s) return null;
      if (name && s.toLowerCase().indexOf(name.toLowerCase()) !== -1) return null; // never the subject
      return s;
    }
    return {
      selectionVersion: 3,
      realCompetitor:  cleanName(parsed.realCompetitor),
      aiRecommends:    cleanName(parsed.aiRecommends),
      globalBenchmark: cleanName(parsed.globalBenchmark),
      source:          String(parsed.source || 'none'),
      categoryUnowned: parsed.categoryUnowned === true,
      reason:          String(parsed.reason || '').slice(0, 300)
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn('[competitor-selection] failed:', err.message);
    return null;
  }
}

async function scoreWithClaude(evidence) {
  try {
    return await scoreWithClaudeOnce(evidence);
  } catch (err) {
    if (String(err.message || '').indexOf('timed out') !== -1) {
      console.warn('[scoring] timed out once — retrying (transient model latency)');
      return await scoreWithClaudeOnce(evidence);
    }
    throw err;
  }
}

async function scoreWithClaudeOnce(evidence) {
  // Dedicated competitor selection first; its decision is injected as fact.
  // Idempotent: on a scoring retry the existing decision is reused, not recomputed.
  try {
    var compDecision = evidence.competitorDecision || await selectDominantCompetitor(evidence);
    if (compDecision) {
      evidence.competitorDecision = compDecision;
      console.log('[competitor-selection] real: ' + (compDecision.realCompetitor || 'none')
        + ' | AI names: ' + (compDecision.aiRecommends || 'none')
        + ' | global benchmark: ' + (compDecision.globalBenchmark || 'none')
        + ' (' + compDecision.source + (compDecision.categoryUnowned ? ', category unowned' : '') + ') \u2014 ' + compDecision.reason);
    }
  } catch (err) {
    console.warn('[competitor-selection] stage error:', err.message);
  }
  var prompt     = buildPrompt(evidence);
  var controller = new AbortController();
  var timeout    = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);

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
        temperature: 0,
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
      throw new Error(data && data.error && data.error.message
        ? data.error.message
        : 'Anthropic HTTP ' + response.status);
    }

    var raw = parseClaudeResponse(data);
    raw = applySignalConstraints(raw, evidence.websiteSignals || {});
    return safeOutput(raw);

  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') throw new Error('Claude request timed out');
    throw error;
  }
}

module.exports = { scoreWithClaude, inferCategory };
