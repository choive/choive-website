// lib/claude.js
// CHOIVE™ evidence-first scoring engine
// Architecture: structured signals confirmed by engine → Claude analyzes → validators normalize
// ENV: ANTHROPIC_API_KEY

'use strict';

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS      = 240000; // scoring gets 4 min; the background function budget is 15
const MAX_TOKENS      = 6500; // raised: richer ground-truth + decision context was clipping long responses mid-JSON

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
    + 'Website content (excerpt): ' + String(websiteText || '').slice(0, 2000) + '\n'
    + 'Search evidence (excerpt): ' + String(searchText || '').slice(0, 2000) + '\n'
    + 'Self-described category (owner\'s own words — fallback only, use if website is thin or absent): ' + category + '\n\n'
    + 'Based PRIMARILY on the WEBSITE CONTENT and SEARCH EVIDENCE above, determine the precise real-world category this business operates in.\n'
    + 'The website is the authoritative source. The self-described category is a weak hint — it may be vague, imprecise, or wrong.\n'
    + 'Return ONLY a JSON object with one field:\n'
    + '{ "inferredCategory": "precise category name" }\n'
    + 'Be specific. Examples:\n'
    + '- Not "software" but "B2B OTT middleware platform for telcos and carmakers"\n'
    + '- Not "coffee" but "B2B specialty coffee roaster and wholesaler"\n'
    + 'CATEGORY FIDELITY \u2014 CRITICAL: when the business explicitly names its own category (in its title, H1, or self-description), USE ITS EXACT WORDS as the core of the category. Never substitute an adjacent industry\u2019s vocabulary: a business calling itself an "AI selection diagnostic" is NOT an "AI evaluation and benchmarking platform" \u2014 those are different markets with different buyers. Paraphrasing the category into a neighboring industry poisons every downstream measurement.\n'    + 'BUSINESS MODEL PRECISION \u2014 CRITICAL: explicitly determine and STATE in the category whether this business (a) OWNS its own production \u2014 a farm, herd, factory, or workshop it controls \u2014 and sells that output directly (a vertically-integrated brand), or (b) CURATES and resells products sourced from multiple outside producers or brands (a retailer or marketplace). These are genuinely different competitive categories even when both sell the identical end product: a farm-owned beef brand competes against OTHER farm-owned beef brands, not against a retailer reselling beef from many farms, and vice versa. If the evidence shows the business names its own farm, herd, or production facility, the category MUST include a phrase like \u201cvertically-integrated brand\u201d or \u201cowns its own [production]\u201d \u2014 never just \u201cretailer\u201d or \u201cdelivery service\u201d for a business that actually produces what it sells. Get this wrong and every downstream competitor match will be comparing the wrong kind of business.\n'
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
        model: ANTHROPIC_MODEL,
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
  if (s.botCrawlable !== null && s.botCrawlable !== undefined) {
    if (s.botEmptyShellDetected) {
      lines.push('AI CRAWLER CHECK (real GPTBot/PerplexityBot/ClaudeBot fetches): FAILED \u2014 ' + (s.botEmptyShellBots || []).join(', ') + ' see a near-empty page despite the static checks above. The site likely renders content client-side (JS), which these crawlers do not execute. This is a REAL crawlability defect, independent of schema/llms.txt.');
    } else if (s.botCrawlable) {
      lines.push('AI CRAWLER CHECK (real GPTBot/PerplexityBot/ClaudeBot fetches): PASSED \u2014 real bot user-agents see substantive content, matching what a normal browser sees.');
    }
  }
  if (s.googleExtendedBlocked) {
    lines.push('Google-Extended (Gemini AI-training crawler): BLOCKED via robots.txt \u2014 this site has opted out of Gemini training/citation.');
  }

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
        + (evidence.competitorDecision.secondAiCompetitor
            && evidence.competitorDecision.secondAiCompetitor !== evidence.competitorDecision.realCompetitor
            && evidence.competitorDecision.secondAiCompetitor !== evidence.competitorDecision.aiRecommends
            ? ' competitors[2] MUST also include: ' + evidence.competitorDecision.secondAiCompetitor + ' \u2014 the second-most-mentioned business in real AI recommendation responses for this category. Set its queryContext to "ai-ground-truth". Ground its analysis in what the AI SELECTION GROUND TRUTH actually said about it.'
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
    + '8. CRITICAL — SAME CATEGORY ONLY: Every competitor in the competitors[] array MUST operate in the same category and serve the same buyer type as the subject. If the subject is B2B, all competitors must be B2B. If the subject sells software to enterprises, do not list consumer products, streaming services, or retail brands — those are NOT competitors. A consumer streaming service is never a competitor of a B2B middleware vendor, even if AI mentioned it frequently. Apply this filter to ALL competitors[] slots — not just the first.\n'
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
    + 'PRESS AND MEDIA ACTION RULE:\n'
    + 'When the Trust signal audit shows "Press or media mention: FAIL" (no confirmed press or media coverage found), you MUST include an action addressing how to get the business named in an independent publication, trade outlet, food blog, industry site, or news source relevant to its category. This is a direct trust signal AI systems use — a business mentioned nowhere outside its own website is treated as unverifiable. The action must:\n'
    + '- Name the specific type of outlet that matters for this business (food media for beef brands, industry press for B2B software, etc.)\n'
    + '- Suggest one concrete, achievable step (pitch to a named outlet type, submit to a specific directory, contribute to an industry forum or podcast)\n'
    + '- Not be generic — tie it to the specific product or story the business has that would be newsworthy\n\n'
    + 'RECOMMENDED PLATFORM \u2014 CRITICAL: name the SINGLE real review or credibility platform that actually matters most for buyers in THIS SPECIFIC inferred category \u2014 reason from the real business type, never default to a generic answer. Examples of the reasoning expected: a B2B software company \u2014 G2 or Capterra; a restaurant \u2014 Google Reviews; a law firm \u2014 Chambers or Legal 500; a hotel \u2014 TripAdvisor and Google; a construction contractor \u2014 Google Business Profile and Houzz; a real estate agency \u2014 Zillow or a local realtor platform; a fitness studio \u2014 Google and ClassPass; a manufacturer or B2B supplier \u2014 industry-specific directories or Clutch; a consumer product brand with no single obvious platform \u2014 Trustpilot is a legitimate default, but only after genuinely considering whether a more specific, category-relevant platform exists first. Trustpilot must never be the reflexive default \u2014 it is correct only when it is truly the platform this buyer type actually checks.\n\n'
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
    + '- HARD CONSTRAINT: if the AI CRAWLER CHECK shows FAILED (empty-shell detected) → score MAXIMUM 6, regardless of schema/llms.txt \u2014 metadata files mean nothing if the actual crawlers you\u2019re being diagnosed for cannot read the page.\n'
    + '- Required: state exactly which signals were confirmed and which were absent\n\n'
    + 'COMPETITOR RULE — SOURCE PRIORITY:\n'
    + 'PRIORITY 1 — AI SELECTION GROUND TRUTH: if the evidence contains an AI SELECTION GROUND TRUTH section, the dominant competitor (competitors[0], the business shown as \u201cAI is recommending instead of you\u201d) MUST be a business named in those AI responses THAT ALSO PASSES EVERY exclusion criterion below — same category, same buyer type, same deal size, not a directory, not the subject business, not a measured platform. Among qualifying names, choose the most prominently recommended — a top pick outranks a list mention; more mentions outrank fewer. The qualifying ground truth OUTRANKS the previously verified competitor: if they disagree, follow the ground truth — this is how past mis-identifications are corrected. Additional competitors (competitors[1..2]) MAY come from search evidence as structural benchmarks.\n'+ 'COMPETITOR ACCURACY: competitors[0] is decided by the dedicated selection stage above (frequency-verified across real AI samples) and must not be second-guessed or overridden here — no name is protected by a previous run; the highest observed, qualifying frequency wins fresh every time.\n'
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
    + 'whyAIRecommendsThem: one sentence — what specific signal or content factor causes AI to name this competitor in recommendation responses? If they appear in the AI SELECTION GROUND TRUTH, quote or paraphrase what AI actually said about them. If from search evidence only, state what trust or visibility signal likely drives the recommendation.\n'
    + 'advantage: one sentence — what structural competitive advantage does this competitor hold over the subject business specifically? Focus on what they have that the subject lacks — review volume, category positioning, brand recognition, trust signals — NOT on why AI names them (that is already covered above).\n'
    + 'gapLocation: one sentence — at exactly what moment in a buyer\'s AI search does this competitor get named instead of [Business]? Name the specific query pattern or buying moment where the displacement happens.\n'
    + 'closeGap: one sentence — what single specific change to [Business]\'s signals would cause AI to include them alongside or instead of this competitor in that same query?\n'
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
    + '- DISPLACEMENT-FIRST ORDERING: If the AI SELECTION GROUND TRUTH shows another business being recommended instead of this one, the FIRST critical action MUST address how to close that specific AI recommendation gap. Name the competitor being recommended. Explain what signal or content change would cause AI to include this business in those same responses. This is the primary CHOIVE finding. Do not lead with schema, llms.txt, or review platform actions if AI displacement was detected — those are supporting actions, not the lead.\n'
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
    + '- REAL ENTITIES ONLY: never name a company, platform, or service in actions or plans unless you are confident it is currently operating. If an entity from search evidence may be defunct or unrecognisable, omit the name entirely.\n'    + '- COMMUNITY OPPORTUNITY: if the evidence contains a REAL BUYER CONVERSATIONS section with an actual thread, forum post, or discussion, ONE action MUST be a tactical, human engagement in that specific conversation \u2014 name the exact platform (e.g. Reddit) and reference what the thread is actually asking, not a generic \u201cengage with your community.\u201d This is a genuinely different KIND of action from institutional fixes (schema, reviews) \u2014 it is immediate, human, and free. Do not substitute a structural fix for this when real community evidence exists; do both. If no real community evidence was found, do not invent a thread \u2014 omit this action type entirely rather than fabricate a plausible-sounding one.\n\n'
    + 'PILLAR FINDINGS — USE THESE EXACT FORMATS:\n'
    + 'Clarity finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Trust finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Difference finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Ease finding: [one short phrase, max 6 words, no punctuation]\n\n'
    + 'PILLAR ANALYSIS — exactly 2 sentences each:\n'
    + 'Sentence 1: Quote or directly reference the specific evidence. Name exact numbers, platforms, signals found or missing.\n'
    + 'Sentence 2: State the exact selection consequence — what a buyer experiences because of this score.\n'
    + 'NEVER write generic analysis. Every sentence must be impossible to apply to a different business.\n\n'
    + 'VERDICT HEADLINE \u2014 max 10 words, no punctuation, strategic advisor tone. '
    + 'AVOID AMBIGUOUS NEGATION: never write "not consistently [positive thing]" or "not always [positive thing]" \u2014 a reader can misparse this as mostly-positive-with-exceptions when the true meaning is the opposite. BANNED EXAMPLE: "Not consistently the obvious choice" (reads as usually chosen, sometimes not \u2014 backwards for a weak/absent tier). Instead state the gap plainly and unambiguously: "Overlooked when it matters most", "Not the default choice yet", "Invisible at the moment of comparison".\n\n'
    + 'SUMMARY PARAGRAPH — exactly 3 sentences:\n'
    + 'DISPLACEMENT SUMMARY RULE — choose exactly one opening based on this priority order:\n'
    + '  1. If the AI SELECTION GROUND TRUTH section names a specific competitor (displacement detected): Sentence 1 MUST be: "When buyers ask AI which [category] to choose in [location/market], [Competitor] is recommended — not [Business Name]."\n'
    + '  2. If tier is dominant or strong AND no displacement competitor was named: Sentence 1 starts with "This business is currently chosen because..."\n'
    + '  3. If tier is upper_mid/mid/weak/absent AND no displacement competitor was named: Sentence 1 starts with "This business operates in a category AI does not yet have a confident answer for — which is both a gap and an opportunity."\n'
    + 'Apply only ONE of these openings. Do not blend them.\n'
    + '- Sentence 2: the single strongest evidence-based driver or gap — name the specific signal or its absence\n'
    + '- Sentence 3: the concrete moment in the buyer journey where this business is lost or won. Name the exact moment.\n\n'
    + 'BUSINESS UNDERSTANDING — what AI currently thinks this business is:\n'
    + 'Write exactly two paragraphs separated by a blank line.\n'
    + 'Paragraph 1 — BEFORE: Write EXACTLY what a language model would output TODAY if someone asked "What is [business name]?" or "Which [category] should I buy in [location]?" — this is a simulation of current AI output, NOT a business description. Use ONLY signals from the evidence. CRITICAL: if the AI SELECTION GROUND TRUTH shows this business was NOT named when buyers asked about its category, the paragraph MUST start with that fact: "[Business] is not a business AI currently names when asked about [category] in [location]." If the knowledge graph is empty, write what AI would say when it has minimal data — it will be vague, hedged, or possibly confused with similar businesses. Do not write a flattering summary. Write what AI actually outputs.\n'
    + 'Paragraph 2 — AFTER: Write what that same AI paragraph would say after the top fixes are implemented.\n'
    + '  Start with the business name. Reference ONLY the concrete fixes from your own actions list\n'
    + '  (e.g. verified reviews on the named platform, llms.txt present, schema confirmed).\n'
    + '  NEVER invent press coverage, publications, client names, awards, or partnerships.\n'
    + '  CRITICAL COHERENCE RULE: this paragraph must never assert a fact that the Trust pillar\u2019s own evidence contradicts elsewhere in this same output \u2014 if CONFIRMED SIGNALS or the review evidence shows zero Trustpilot/Google presence, this paragraph may NEVER say reviews are "verified" or "confirmed" as if they already exist. Describe the fix as pending, not as already accomplished: e.g. "once verified reviews are live on Trustpilot" not "verified reviews on Trustpilot confirm.\u201d A contradiction between this paragraph and the Trust pillar\u2019s own finding is a critical defect, not a stylistic choice.\n'
    + '  NEVER use bracket placeholders like [platform] or [publication] — name the real platform from your actions or omit it.\n'
    + '  Phrase it as what AI would say once those specific fixes are verifiably in place. Nothing beyond them.\n'
    + '  The contrast between the two paragraphs is the core value of this field.\n\n'
    + 'EVIDENCE NARRATIVE RULES:\n'
    + 'LEAD WITH THE AI FINDING: If the AI SELECTION GROUND TRUTH section names a specific competitor, the evidence narrative MUST open with that fact: "Real AI recommendation queries for [category] in [location] returned [Competitor] as the named answer — [Business] was not mentioned." This is the most important finding in the entire report and must never be buried.\n'
    + 'Write exactly what was found and what was not found. Name specific search queries that returned zero results.\n'
    + 'Name specific signals that were confirmed. Name the exact gap between what exists and what is needed.\n'
    + 'Do not summarise. Do not soften. Do not generalise. Every sentence must be evidence-backed.\n\n'
    + 'SIGNAL AUDIT — populate signalAudit with EXACTLY the signals below per pillar. Use ONLY these three status values: "pass", "fail", "partial".\n'
    + 'For each signal, detail must be a short specific phrase (max 12 words) — name the exact value found, or state exactly what was missing.\n'
    + 'NEVER leave detail blank on a "pass". NEVER write "N/A" or "none". NEVER invent data not in the evidence.\n\n'
    + 'CLARITY signals (check in order):\n'
    + '1. "H1 headline names the service" — pass if H1 text contains the specific product/service category; fail if generic or absent\n'
    + '2. "Meta description present" — pass if confirmed; fail if missing\n'
    + '3. "Business name consistent across sources" — pass if search results show consistent name; partial if variation found; fail if conflicting\n'
    + '4. "Homepage category immediately clear" — pass if first content clearly states what business does; partial if vague; fail if absent\n\n'
    + 'TRUST signals (check in order):\n'
    + '1. "Google reviews" — pass if rating + count found; partial if profile exists but low volume (<5); fail if none\n'
    + '2. "Trustpilot presence" — pass if found with rating; fail if not found\n'
    + '3. "Press or media mention" — pass if named publication found in search evidence; fail if none found\n'
    + '4. "Case study or named client result" — pass if specific result with named client found; partial if result exists but no name; fail if none\n\n'
    + 'DIFFERENCE signals (check in order):\n'
    + '1. "Named differentiator stated" — pass if a specific unique claim exists (not "best" or "quality"); partial if vague claim only; fail if none\n'
    + '2. "Named client or partner referenced" — pass if a specific company/person is named; fail if none\n'
    + '3. "Niche or category ownership claim" — pass if business explicitly owns a defined niche; partial if implied; fail if absent\n'
    + '4. "Proof of outcome stated" — pass if a measurable result is cited (number, %, time); fail if none\n\n'
    + 'EASE signals (check in order):\n'
    + '1. "Schema markup present" — pass if detected; fail if none found\n'
    + '2. "llms.txt file present" — pass if confirmed; fail if absent\n'
    + '3. "AI crawlers can read page" — pass if bots see substantive content; partial if thin; fail if blocked or empty shell\n'
    + '4. "Structured FAQ or explainer content" — pass if clear question/answer format found; partial if present but thin; fail if absent\n\n'
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
    + '  "recommendedPlatform": { "name": "", "url": "", "reason": "" },\n'
    + '  "pillars": {\n'
    + '    "clarity":    { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n'
    + '    "trust":      { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n'
    + '    "difference": { "score": 0, "finding": "", "analysis": "", "evidence": "" },\n'
    + '    "ease":       { "score": 0, "finding": "", "analysis": "", "evidence": "" }\n'
    + '  },\n'
    + '  "signalAudit": {\n'
    + '    "clarity":    [ { "name": "", "status": "pass", "detail": "" } ],\n'
    + '    "trust":      [ { "name": "", "status": "pass", "detail": "" } ],\n'
    + '    "difference": [ { "name": "", "status": "pass", "detail": "" } ],\n'
    + '    "ease":       [ { "name": "", "status": "pass", "detail": "" } ]\n'
    + '  },\n'
    + '  "competitors": [\n'
    + '    { "name": "", "whyAIRecommendsThem": "", "advantage": "", "gapLocation": "", "closeGap": "", "evidence": "", "queryContext": "search" },\n'
    + '    { "name": "", "whyAIRecommendsThem": "", "advantage": "", "gapLocation": "", "closeGap": "", "evidence": "", "queryContext": "search" }\n'
    + '  ],\n'
    + '  "actions": [\n'
    + '    { "priority": "critical", "title": "", "body": "", "explanation": "", "if_nothing": "" },\n'
    + '    { "priority": "critical", "title": "", "body": "", "explanation": "", "if_nothing": "" },\n'
    + '    { "priority": "high",     "title": "", "body": "", "explanation": "", "if_nothing": "" },\n'
    + '    { "priority": "medium",   "title": "", "body": "", "explanation": "", "if_nothing": "" }\n'
    + '  ]\n'
    + '}';

  var competitorReminder = (evidence.competitorDecision && evidence.competitorDecision.realCompetitor)
    ? 'IMPORTANT: competitors[0].name must be exactly "' + String(evidence.competitorDecision.realCompetitor).replace(/"/g, '\\"') + '". Do not alter it.\n\n'
    : '';
  return prompt + competitorReminder + jsonSchema;
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
    // Apply floors first, then re-read the live score before applying caps
    // so earlier mutations are visible to later checks.
    if (s.hasLlmsTxt && ease < 18) { p.ease.score = Math.max(ease, 18); ease = p.ease.score; }
    if (s.hasSchema  && ease < 12) { p.ease.score = Math.max(ease, 12); ease = p.ease.score; }
    // No-schema cap only applies when llms.txt is also absent —
    // having llms.txt is itself a strong AI-readability signal.
    if (!s.hasSchema && !s.hasLlmsTxt && ease > 8) { p.ease.score = Math.min(ease, 8); ease = p.ease.score; }
    // Empty-shell sites cap at 6 regardless of what the model scored \u2014 a
    // code-level cap, not just a prompt instruction, because llms.txt/schema
    // presence has repeatedly proven persuasive enough to override prose
    // rules alone. Real crawlers seeing a blank page is the actual defect
    // Ease is supposed to measure; static files are a proxy, not the fact.
    if (s.botEmptyShellDetected && p.ease.score > 6) { p.ease.score = 6; }
    if (s.allBotsFailed && p.ease.score > 3) { p.ease.score = 3; }
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

  // ── Signal audit overrides ────────────────────────────────────────────────
  // Replace Claude's generated statuses for signals we can verify
  // programmatically from websiteSignals. Non-technical signals (press,
  // case studies, differentiators) stay as Claude assessed them.
  var sa = rawOutput.signalAudit;
  if (sa && typeof sa === 'object') {
    // Helper: find a signal entry by name prefix (case-insensitive)
    function overrideSignal(pillar, namePrefix, status, detail) {
      var arr = sa[pillar];
      if (!Array.isArray(arr)) return;
      var idx = -1;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && String(arr[i].name || '').toLowerCase().indexOf(namePrefix.toLowerCase()) === 0) {
          idx = i; break;
        }
      }
      if (idx !== -1) {
        arr[idx].status = status;
        arr[idx].detail = detail;
      } else {
        // Signal wasn't generated by Claude — add it anyway so it's always shown
        arr.push({ name: namePrefix, status: status, detail: detail });
      }
    }

    // CLARITY — H1 and meta description
    if (s.hasH1) {
      var h1Detail = s.h1Text ? ('"' + String(s.h1Text).slice(0, 60) + '"') : 'H1 present';
      overrideSignal('clarity', 'H1 headline', 'pass', h1Detail);
    } else {
      overrideSignal('clarity', 'H1 headline', 'fail', 'No H1 tag detected on page');
    }
    if (s.hasMetaDescription) {
      var metaSnip = s.metaDescriptionText ? ('"' + String(s.metaDescriptionText).slice(0, 60) + '"') : 'Meta description present';
      overrideSignal('clarity', 'Meta description', 'pass', metaSnip);
    } else {
      overrideSignal('clarity', 'Meta description', 'fail', 'No meta description found');
    }

    // TRUST — Google reviews and Trustpilot
    if (s.googleRating && s.googleReviewCount) {
      overrideSignal('trust', 'Google reviews', 'pass', s.googleRating + '★ · ' + s.googleReviewCount + ' reviews');
    } else if (s.googleRating) {
      overrideSignal('trust', 'Google reviews', 'partial', s.googleRating + '★ · review count not confirmed');
    } else {
      overrideSignal('trust', 'Google reviews', 'fail', 'No Google profile found');
    }
    if (s.trustpilotRating && s.trustpilotReviewCount) {
      overrideSignal('trust', 'Trustpilot', 'pass', s.trustpilotRating + '/5 · ' + s.trustpilotReviewCount + ' reviews');
    } else if (s.trustpilotRating) {
      overrideSignal('trust', 'Trustpilot', 'partial', s.trustpilotRating + '/5 · review count not confirmed');
    } else {
      overrideSignal('trust', 'Trustpilot', 'fail', 'No Trustpilot profile found');
    }

    // EASE — schema, llms.txt, bot crawlability
    if (s.hasSchema) {
      var schemaDetail = (s.schemaCount && s.schemaCount > 0)
        ? (s.schemaCount + ' schema type' + (s.schemaCount > 1 ? 's' : '') + (s.schemaTypes && s.schemaTypes.length ? ': ' + s.schemaTypes.slice(0, 2).join(', ') : ''))
        : 'Schema markup detected';
      overrideSignal('ease', 'Schema markup', 'pass', schemaDetail);
    } else {
      overrideSignal('ease', 'Schema markup', 'fail', 'No JSON-LD or schema detected');
    }
    if (s.hasLlmsTxt) {
      overrideSignal('ease', 'llms.txt file', 'pass', 'llms.txt confirmed at root');
    } else {
      overrideSignal('ease', 'llms.txt file', 'fail', 'No llms.txt found');
    }
    if (s.botEmptyShellDetected) {
      overrideSignal('ease', 'AI crawlers can read page', 'fail', 'Bots see empty shell — JS-only render');
    } else if (s.allBotsFailed) {
      overrideSignal('ease', 'AI crawlers can read page', 'fail', 'All bot fetches blocked or failed');
    } else if (s.botCrawlable === false) {
      overrideSignal('ease', 'AI crawlers can read page', 'partial', 'Partial content visible to bots');
    } else {
      overrideSignal('ease', 'AI crawlers can read page', 'pass', 'Bots see substantive page content');
    }
  }

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
    businessUnderstanding: r.businessUnderstanding || '',
    evidenceNarrative:     r.evidenceNarrative    || '',
    inferredCategory:      r.inferredCategory     || '',
    signatureLine:         r.signatureLine        || '',
    marketPosition:        r.marketPosition       || { tier: 'unknown', reasoning: '' },
    platformCoverage:      r.platformCoverage     || { chatgpt: 'weak', perplexity: 'weak', gemini: 'weak', claude: 'weak' },
    selectionGap:          r.selectionGap         || 0,
    recommendedPlatform:   (r.recommendedPlatform && r.recommendedPlatform.name) ? r.recommendedPlatform : null,
    pillars: {
      clarity:    safePillar(pillars.clarity),
      trust:      safePillar(pillars.trust),
      difference: safePillar(pillars.difference),
      ease:       safePillar(pillars.ease)
    },
    signalAudit: (r.signalAudit && typeof r.signalAudit === 'object') ? r.signalAudit : { clarity: [], trust: [], difference: [], ease: [] },
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

// ── Candidate frequency counting ──────────────────────────────────────────
// Counts how often each candidate name appears across the FULL raw
// ground-truth corpus (every independent sample, not just one representative
// response per query). This is the deterministic replacement for
// continuity/"protect the old answer" \u2014 accuracy comes from measuring
// real frequency, not from defending a prior run's pick.
function normalizeForCount(s) {
  s = String(s || '').toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
  return s.replace(/\b(gmbh|ag|kg|ug|inc|llc|ltd|co|company|de|com)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function countCandidateFrequency(candidateName, corpus) {
  var target = normalizeForCount(candidateName);
  if (!target) return 0;
  var count = 0;
  corpus.forEach(function(text) {
    var body = ' ' + normalizeForCount(text) + ' ';
    if (body.indexOf(' ' + target + ' ') !== -1) count++;
  });
  return count;
}

// Builds the candidate list (owner-named, website-declared, search-evidence,
// and the previous run's pick \u2014 now just ONE candidate among equals, with
// no special protection) and their observed frequency across every raw
// ground-truth sample.
function buildFrequencyTable(evidence, subjectName) {
  var seen = {};
  var candidates = [];
  var push = function(n) {
    var s = String(n || '').trim();
    if (!s) return;
    var key = normalizeForCount(s);
    if (!key || seen[key]) return;
    if (subjectName && key.indexOf(normalizeForCount(subjectName)) !== -1) return; // never the subject
    seen[key] = 1;
    candidates.push(s);
  };
  String(evidence.knownCompetitors || '').split(',').forEach(push);
  // FIX G — skip domain-format strings (e.g. "example.com") — only push real business names
  (evidence.competitors || []).forEach(function(c) {
    var val = c.name || c.domain;
    if (val && !/\.[a-z]{2,4}(\s|\/|$)/i.test(val)) push(val);
  });
  if (evidence.previousCompetitor) push(evidence.previousCompetitor);

  var corpus = [];
  var simBefore = evidence.aiSimulationBefore;
  if (simBefore && simBefore.before && Array.isArray(simBefore.before.results)) {
    simBefore.before.results.forEach(function(r) {
      if (Array.isArray(r.allResponses) && r.allResponses.length) {
        corpus = corpus.concat(r.allResponses);
      } else if (r.response) {
        corpus.push(r.response); // fallback for older cached results without allResponses
      }
    });
  }

  var table = candidates.map(function(c) {
    return { name: c, frequency: countCandidateFrequency(c, corpus), sampleSize: corpus.length };
  }).sort(function(a, b) { return b.frequency - a.frequency; });

  return { table: table, corpusSize: corpus.length };
}

async function selectDominantCompetitor(evidence) {
 try {
  var name       = String(evidence.name || '').trim();
  var category   = String(evidence.category || '').trim();
  var inferred   = String(evidence.inferredCategory || category).trim();
  var previous   = sanitizeExternal(String(evidence.previousCompetitor || '')).trim();
  var known      = String(evidence.knownCompetitors || '').trim();
  var summary    = String((evidence.summaries || {}).businessSummary || '').slice(0, 600);
  var siteText   = sanitizeExternal(String(evidence.websiteText || '')).slice(0, 900);
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

  // Deterministic frequency table \u2014 replaces continuity/"protect the
  // old answer" with real measurement: how often does each real candidate
  // actually appear across every raw ground-truth sample. No name is
  // protected by a prior run anymore; the highest verified frequency wins,
  // recomputed fresh every time.
  var freq;
  try {
    freq = buildFrequencyTable(evidence, name);
  } catch (freqErr) {
    console.warn('[competitor-selection] buildFrequencyTable failed:', freqErr.message);
    freq = { table: [], corpusSize: 0 };
  }
  var freqTableText = freq.table.length
    ? freq.table.map(function(c) { return '- ' + c.name + ': named in ' + c.frequency + ' of ' + c.sampleSize + ' independent AI samples'; }).join('\n')
    : 'No candidates identified from owner input, website declarations, or search evidence.';

  var prompt = 'You verify and rank real-world competitors for a business diagnostic using OBSERVED FREQUENCY across real AI samples \u2014 not reasoning from scratch. Respond ONLY with a JSON object, no markdown, no preamble.\n\n'
    + 'SUBJECT BUSINESS: ' + name + (website ? ' (' + website + ')' : '') + '\n'
    + 'CATEGORY: ' + inferred + '\n'
    + (city ? 'MARKET / LOCATION: ' + city + '\n' : '')
    + (siteText ? 'SUBJECT\u2019S OWN WEBSITE (excerpt \u2014 note any competitors it names or compares against): ' + siteText + '\n' : '')
    + (summary ? 'WHAT IT DOES: ' + summary + '\n' : '')
    + (known ? 'COMPETITORS NAMED BY THE OWNER (highest-truth source): ' + known + '\n' : '')
    + '\nOBSERVED FREQUENCY ACROSS ' + freq.corpusSize + ' INDEPENDENT AI SAMPLES (this run\u2019s real ground truth \u2014 no candidate is protected by any previous run):\n' + freqTableText + '\n'
    + (groundTruth ? '\nAI SELECTION GROUND TRUTH \u2014 what AI actually recommended when asked for this category:\n' + groundTruth + '\n' : '')
    + (searchComps ? '\nCOMPETITORS FOUND IN SEARCH EVIDENCE: ' + searchComps + '\n' : '')
    + '\nProduce TWO answers:\n\n'
   + 'ANSWER A \u2014 realCompetitor: the subject\u2019s TRUE head-to-head market rival \u2014 the company a knowledgeable buyer or the owner would name as the direct alternative in a deal. GROUNDING REQUIREMENT, NO EXCEPTIONS: realCompetitor MUST be a name that actually appears somewhere in the evidence provided \u2014 either (a) in the AI SELECTION GROUND TRUTH text itself (what AI actually answered, even if it is not one of the pre-listed frequency-table candidates), (b) in the frequency table / search evidence, or (c) explicitly owner-named or website-declared. It may NEVER be a name recalled purely from general training knowledge with no supporting evidence anywhere in this prompt \u2014 confirmed live: this produced a fabricated, ungrounded competitor (\u201cBeef Bandits\u201d) that appeared nowhere in any real evidence for the business. A name you \u201cknow\u201d to be a real company in the category is NOT sufficient on its own; it must also be traceable to something actually observed in THIS run\u2019s evidence. Requirements beyond grounding: same category, same buyer type, comparable deal size, AND SAME SERVICEABLE MARKET \u2014 a business the subject\u2019s own customers could actually buy from instead. A company that does not sell, ship, or operate where the subject\u2019s customers are FAILS this test no matter how similar the product (a US-only meat brand is NOT the rival of a Germany-only meat brand; a Switzerland-only delivery service is NOT the rival of a business selling to German customers). PLATFORMS ARE NOT RIVALS: review marketplaces (G2, Trustpilot, Capterra), model hubs, app stores, directories, and general infrastructure are channels a recommendation flows through \u2014 never a head-to-head competitor, unless the subject itself is such a platform. SAME BUYER means the SAME PERSON spends the money: a tool bought by HR teams to screen candidates is NOT the rival of a tool bought by business owners to improve their AI visibility, even when their names share words. MARKET CONFIDENCE RULE: if you are not CONFIDENT a candidate actually sells or delivers to the subject\u2019s market, it FAILS \u2014 uncertainty disqualifies, never the reverse. A real, currently operating NAMED COMPANY \u2014 not a generic category description (\u201ccertified direct marketers\u201d, \u201clocal organic suppliers\u201d are types of seller, not a business); if the ground truth only offers a generic description, treat it as no qualifying name; never a directory, aggregator, or adjacent giant from another industry (e.g. a data-labeling company is NOT a rival to an AI-visibility tool); never the subject or a name variant. RANK BY OBSERVED FREQUENCY, NO PROTECTED PRIOR: verify EVERY candidate in the frequency table above against ALL the requirements listed \u2014 same category, same buyer, same market, real named entity, not a platform, GROUNDED in evidence. Among candidates that PASS, the one with the HIGHEST observed frequency is realCompetitor \u2014 this includes any name from a previous run, which is now just one candidate among equals with no special protection. If the top two qualifying candidates are within 1 sample of each other (a genuine statistical tie, not a clear leader), set contested:true and still name the higher-frequency one \u2014 the report should describe this as a close, active race rather than a settled fact. Do not let low-frequency noise (a candidate named in only 1 of many samples) outrank a name with zero real evidence just because it sounds plausible \u2014 frequency is the tiebreaker between qualifying candidates, not a license to invent one. IF EVERY CANDIDATE IN THE FREQUENCY TABLE FAILS: check the raw AI SELECTION GROUND TRUTH text directly for a qualifying name that simply was not in the pre-built candidate list \u2014 this is not \u201cusing your own knowledge\u201d, it is reading evidence already provided. If NOTHING in the frequency table, the raw ground truth text, or the search evidence qualifies, return null and set categoryUnowned accordingly. This is the honest, correct, publishable answer for a business with genuinely no evidenced rival \u2014 it is never acceptable to substitute a name with no evidentiary basis just to avoid returning null.\n\n'
    + 'ANSWER B \u2014 aiRecommends: from the AI SELECTION GROUND TRUTH only \u2014 the most prominently recommended business that passes THE SAME TESTS AS ANSWER A: genuinely the subject\u2019s category, the same buyer, the same serviceable market (a local subject\u2019s displacer is local; a global subject\u2019s is global). The owner sees this name under \u201cAI is currently recommending instead of you\u201d \u2014 so it must be a business that could actually take the subject\u2019s customers. NEVER a platform, marketplace, directory, review site, or adjacent-industry player, no matter how prominently AI named it \u2014 those are venues or strangers, not displacers. If every name AI gave fails these tests, aiRecommends = null and categoryUnowned = true: nobody in the category is being recommended, and that is the honest, publishable finding.\n\n'
    + 'Also report categoryUnowned: true if NO business in the ground truth is genuinely in the subject\u2019s category (AI answered with adjacent players) \u2014 meaning the category answer is unowned.\n\n'
    + 'Respond with exactly: {"realCompetitor": <name or null>, "aiRecommends": <name or null>, "globalBenchmark": <name or null>, "source": "owner" | "website_declared" | "frequency" | "industry_knowledge" | "none", "categoryUnowned": <true|false>, "contested": <true|false>, "reason": "<one sentence citing the observed frequency, e.g. \\"named in 5 of 8 samples, more than any other qualifying candidate\\">"}';

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
    var fi = text.indexOf('{'), li = text.lastIndexOf('}');
    var jsonText = (fi !== -1 && li > fi) ? text.slice(fi, li + 1) : text;
    var parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object') return null;
    function cleanName(v) {
      var s = v ? String(v).trim() : '';
      if (!s) return null;
      // Exclude only exact matches (after normalization) — substring check was
      // too broad and silently dropped valid competitors sharing a name prefix.
      var normS = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      var normN = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (normN && normS === normN) return null; // never the exact subject
      // FIX H — also reject partial trading-name overlaps (e.g. "Acme" matching "Acme GmbH")
      // Require at least 4 chars of overlap to avoid coincidental short-prefix matches.
      if (normN && normS && normN.length >= 4 && normS.length >= 4) {
        if (normS.startsWith(normN) || normN.startsWith(normS)) return null;
      }
      return s;
    }
    // No stability fallback anymore \u2014 if the model can't name a real,
    // frequency-backed candidate, the honest answer is null (categoryUnowned
    // territory), not a silently reused prior. Accuracy replaces protection.
    var decidedReal = cleanName(parsed.realCompetitor);
    return {
      selectionVersion: 4, // v4: frequency-based selection, no continuity protection
      realCompetitor:  decidedReal,
      aiRecommends:    cleanName(parsed.aiRecommends),
      globalBenchmark: cleanName(parsed.globalBenchmark),
      source:          String(parsed.source || 'none'),
      categoryUnowned: parsed.categoryUnowned === true,
      contested:       parsed.contested === true,
      frequencyTable:  freq.table.slice(0, 5), // for logging/transparency
      reason:          String(parsed.reason || '').slice(0, 300)
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn('[competitor-selection] failed:', err.message);
    return null;
  }
 } catch (outerErr) {
  // Closes the SILENT-FAILURE gap confirmed live: buildFrequencyTable or the
  // prompt-construction lines ran completely unguarded before this fix \u2014
  // any error there rejected the whole function with zero log output at all,
  // leaving a diagnostic with competitorDecision entirely unset and no trace
  // of why. Now every failure path, wherever it happens, logs clearly.
  console.warn('[competitor-selection] outer stage error (before the API call):', outerErr.message);
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
    var existingDecision = evidence.competitorDecision;
    // Skip selectDominantCompetitor ONLY when the prior extraction was high-confidence:
    //   selectionVersion 4 (direct Claude extraction, not frequency fallback)
    //   AND mentionCount >= 2 (appeared in at least 2 of 3 simulation responses)
    //   AND realCompetitor is non-null
    // In all other cases — no prior decision, low confidence (count=1), frequency
    // fallback (v3), or empty result — run the full sophisticated selection which has
    // grounding requirements, same-serviceable-market checks, and geography validation
    // that the quick background extraction lacks.
    var highConfidence = existingDecision
      && existingDecision.realCompetitor
      && existingDecision.selectionVersion >= 4
      && (existingDecision.mentionCount || 0) >= 2;
    var compDecision = highConfidence
      ? existingDecision
      : await selectDominantCompetitor(evidence);
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

    if (!response.ok) {
      var errBody = '';
      try { var errJson = await response.json(); errBody = (errJson && errJson.error && errJson.error.message) ? errJson.error.message : ''; } catch (e) {}
      throw new Error(errBody || 'Anthropic HTTP ' + response.status);
    }
    var data = await response.json();
    if (data.stop_reason && data.stop_reason !== 'end_turn') {
      console.warn('[CHOIVE] Unexpected stop_reason:', data.stop_reason, '— response may be truncated');
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

// ── CHANNEL COMPETITOR SELECTION ─────────────────────────────────────────────
// Used only when dual-arena is detected. Asks Claude to identify the dominant
// online/DTC seller for this product category in this market — not the brand
// peer (which selectDominantCompetitor handles) but the established e-commerce
// player a buyer would find by searching "buy [product] online [market]".
async function selectChannelCompetitor(evidence, channelResults) {
  var name     = String(evidence.name || '').trim();
  var category = String(evidence.inferredCategory || evidence.category || '').trim();
  var city     = String(evidence.city || '').trim();

  var candidateLines = (channelResults.competitors || []).map(function(c) {
    return '- ' + (c.domain || '') + (c.title ? ' ("' + c.title.slice(0, 70) + '")' : '');
  }).filter(Boolean).slice(0, 8).join('\n');

  var searchExcerpt = sanitizeExternal(String(channelResults.searchText || '')).slice(0, 2000);

  if (!candidateLines && !searchExcerpt) return null;

  var prompt = 'You identify the dominant online/DTC seller in a product category and market. Respond ONLY with valid JSON, no markdown, no explanation outside the JSON.\n\n'
    + 'SUBJECT BUSINESS: ' + name + '\n'
    + 'PRODUCT CATEGORY: ' + category + '\n'
    + (city ? 'MARKET: ' + city + '\n' : '')
    + (candidateLines ? '\nCANDIDATES FROM "buy online" SEARCH:\n' + candidateLines + '\n' : '')
    + (searchExcerpt  ? '\nSEARCH RESULTS EXCERPT:\n' + searchExcerpt + '\n' : '')
    + '\nIdentify the ONE business that most clearly owns the online/e-commerce buying experience for this product in this market — the company a buyer would land on when searching "buy [product] online". '
    + 'Requirements: (1) actually sells and delivers this product type online, (2) serves the same market/country as ' + name + ', '
    + '(3) is NOT ' + name + ' itself, (4) is NOT a marketplace or aggregator (Amazon, eBay, Etsy, Google Shopping etc), '
    + '(5) PREFER businesses appearing in the evidence, but if evidence is sparse you MAY use verified general knowledge for well-known markets. '
    + 'Return null if genuinely uncertain. '
    + 'This is the CHANNEL competitor, not the brand peer — ordering experience and delivery dominate this arena, not product quality or heritage.\n\n'
    + 'Respond with exactly: {"name": <string or null>, "domain": <string or null>, "reason": "<one sentence>"}';

  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 20000);
  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 200, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn('[channel-competitor] Anthropic ' + res.status); return null; }
    var data = await res.json();
    var text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; })
      .join('').replace(/```json|```/g, '').trim();
    var fi2 = text.indexOf('{'), li2 = text.lastIndexOf('}');
    var jsonText2 = (fi2 !== -1 && li2 > fi2) ? text.slice(fi2, li2 + 1) : text;
    var parsed = JSON.parse(jsonText2);
    if (!parsed || !parsed.name) return null;
    return {
      name:   String(parsed.name).trim(),
      domain: String(parsed.domain || '').trim(),
      reason: String(parsed.reason || '').slice(0, 200),
      source: 'channel-search'
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn('[channel-competitor] failed:', err.message);
    return null;
  }
}

// ── DUAL-ARENA PILLAR SCORING ─────────────────────────────────────────────────
// Called only when dual-arena is active. Scores the competitor in ONE arena
// (brand or online) using a lightweight Claude call.
// Returns: { arenaType, competitorName, pillars: { clarity, trust, difference, ease },
//            keyGap, priorityAction }
// Each pillar: { you: <0-25>, competitor: <0-25>, gap: <signed int> }
// Fails soft — caller catches and ignores.
async function scoreArena(evidence, mainResult, competitorName, arenaType) {
  if (!competitorName) return null;
  var name     = String(evidence.name || '').trim();
  var category = String(evidence.inferredCategory || evidence.category || '').trim();
  var city     = String(evidence.city || '').trim();

  var subjectPillars = (mainResult && mainResult.pillars) || {};
  function s(pillar) { return Number((subjectPillars[pillar] && subjectPillars[pillar].score) || 0); }
  var youClarity    = s('clarity');
  var youTrust      = s('trust');
  var youDifference = s('difference');
  var youEase       = s('ease');

  var searchExcerpt = sanitizeExternal(
    String(evidence.searchText || '').slice(0, 1500)
    + '\n' + String(evidence.competitorPageText || '').slice(0, 1000)
  );

  var arenaLabel = arenaType === 'online'
    ? 'online/DTC channel (ordering experience, delivery, online UX)'
    : 'brand/product arena (specialty product quality, heritage, breed specificity)';

  var arenaContext = arenaType === 'online'
    ? 'In this arena, buyers decide based on: ease of ordering online, delivery reliability, website clarity, DTC trust signals (reviews, returns policy), and online brand presence.'
    : 'In this arena, buyers decide based on: breed/product specificity, source transparency, production method, provenance claims, and specialty positioning.';

  var prompt = 'You compare two businesses on the CHOIVE four pillars within a specific competitive arena. '
    + 'Respond ONLY with valid JSON, no markdown, no text outside the JSON.\n\n'
    + 'SUBJECT BUSINESS: ' + name + '\n'
    + 'COMPETITOR: ' + competitorName + '\n'
    + 'PRODUCT CATEGORY: ' + category + '\n'
    + (city ? 'MARKET: ' + city + '\n' : '')
    + 'ARENA: ' + arenaLabel + '\n'
    + arenaContext + '\n\n'
    + 'SUBJECT\'S CONFIRMED PILLAR SCORES (from full diagnostic):\n'
    + '  Clarity: ' + youClarity + '/25\n'
    + '  Trust: ' + youTrust + '/25\n'
    + '  Difference: ' + youDifference + '/25\n'
    + '  Ease: ' + youEase + '/25\n\n'
    + 'AVAILABLE EVIDENCE (excerpts):\n' + searchExcerpt + '\n\n'
    + 'TASK: Estimate ' + competitorName + '\'s pillar scores IN THIS SPECIFIC ARENA ONLY. '
    + 'Use the same 0-25 scale per pillar. Base estimates on the evidence and your knowledge of this competitor. '
    + 'Gap = your score minus competitor score (positive = you lead, negative = competitor leads).\n\n'
    + 'Also identify the single biggest gap (the pillar where the subject is most behind in this arena) '
    + 'and one specific priority action to close it.\n\n'
    + 'Respond with exactly this JSON structure:\n'
    + '{\n'
    + '  "pillars": {\n'
    + '    "clarity":    { "you": ' + youClarity    + ', "competitor": 0, "gap": 0 },\n'
    + '    "trust":      { "you": ' + youTrust      + ', "competitor": 0, "gap": 0 },\n'
    + '    "difference": { "you": ' + youDifference + ', "competitor": 0, "gap": 0 },\n'
    + '    "ease":       { "you": ' + youEase       + ', "competitor": 0, "gap": 0 }\n'
    + '  },\n'
    + '  "keyGap": "<pillar name where subject is most behind in this arena>",\n'
    + '  "priorityAction": "<one specific sentence: what to change in this arena>"\n'
    + '}';

  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 25000);
  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 350, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn('[scoreArena] Anthropic ' + res.status); return null; }
    var data = await res.json();
    var text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; })
      .join('').replace(/```json|```/g, '').trim();
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      // Try to extract JSON
      var jStart = text.indexOf('{'); var jEnd = text.lastIndexOf('}');
      if (jStart !== -1 && jEnd > jStart) { try { parsed = JSON.parse(text.slice(jStart, jEnd + 1)); } catch (_) {} }
    }
    if (!parsed || !parsed.pillars) return null;

    // Fill in "you" scores (always use confirmed values from main diagnostic)
    // and compute gaps deterministically — never trust what the model writes for "you" or "gap"
    var pillars = parsed.pillars;
    function fixPillar(key, youScore) {
      var p = pillars[key] || {};
      var comp = Math.max(0, Math.min(25, Number(p.competitor) || 0));
      return { you: youScore, competitor: comp, gap: youScore - comp };
    }
    return {
      arenaType:      arenaType,
      competitorName: competitorName,
      pillars: {
        clarity:    fixPillar('clarity',    youClarity),
        trust:      fixPillar('trust',      youTrust),
        difference: fixPillar('difference', youDifference),
        ease:       fixPillar('ease',       youEase)
      },
      keyGap:         String(parsed.keyGap         || '').slice(0, 50),
      priorityAction: String(parsed.priorityAction || '').slice(0, 600)
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn('[scoreArena] failed (' + arenaType + '):', err.message);
    return null;
  }
}

module.exports = { scoreWithClaude, inferCategory, selectChannelCompetitor, scoreArena };
