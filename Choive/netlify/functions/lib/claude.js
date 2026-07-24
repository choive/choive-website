// lib/claude.js
// CHOIVE™ evidence-first scoring engine
// Architecture: structured signals confirmed by engine → Claude analyzes → validators normalize
// ENV: ANTHROPIC_API_KEY

'use strict';

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5-20251001';
const { logAnthropicUsage } = require('./anthropic-usage');
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
async function inferCategory(name, category, websiteText, searchText, subjectType) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 30000);
  subjectType = String(subjectType || 'business').trim();
  var subjectInstruction = subjectType === 'creator'
    ? 'Identify the creator\'s primary topic, content format, audience, and geographic relevance. Do not force a commercial business category.'
    : subjectType === 'personal_brand'
      ? 'Identify the person\'s primary expertise, public role, audience, and geographic relevance. Do not force a company or retail category.'
      : subjectType === 'organization'
        ? 'Identify the organization\'s mission, activity, people served, and geographic scope. Do not assume it sells a product.'
        : subjectType === 'product'
          ? 'Identify the exact product or service type, its primary use, intended users, and geographic availability.'
          : 'Identify the exact product or service sold, the buyer, the commercial model, and the geographic market.';
  var prompt = 'Subject name: ' + name + '\n'
    + 'Subject type: ' + subjectType + '\n'
    + 'Website content (excerpt): ' + String(websiteText || '').slice(0, 2000) + '\n'
    + 'Search evidence (excerpt): ' + String(searchText || '').slice(0, 2000) + '\n'
    + 'Self-described category (owner\'s own words — fallback only, use if website is thin or absent): ' + category + '\n\n'
    + 'Based PRIMARILY on the WEBSITE CONTENT and SEARCH EVIDENCE above, determine the subject\'s precise real-world category.\n'
    + 'SUBJECT-SPECIFIC RULE: ' + subjectInstruction + '\n'
    + 'The website is the authoritative source. The self-described category is a weak hint — it may be vague, imprecise, or wrong.\n'
    + 'Return ONLY a JSON object with one field:\n'
    + '{ "inferredCategory": "precise category name" }\n'
    + 'Be specific. Examples:\n'
    + '- Not "software" but "B2B OTT middleware platform for telcos and carmakers"\n'
    + '- Not "coffee" but "B2B specialty coffee roaster and wholesaler"\n'
    + 'CATEGORY FIDELITY \u2014 CRITICAL: when the subject explicitly names its own category in its title, H1, or self-description, USE ITS EXACT WORDS as the core of the category. Never substitute an adjacent category\u2019s vocabulary.\n'
    + ((subjectType === 'business' || subjectType === 'product')
      ? 'BUSINESS MODEL PRECISION \u2014 CRITICAL: determine whether the subject owns production and sells its output directly, or curates and resells products from outside producers. These are different competitive categories.\n'
      : '')
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
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 100,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return category;
    var data = await response.json();
    logAnthropicUsage('category-inference', data);
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
    } else if (s.allBotsFailed) {
      lines.push('AI CRAWLER CHECK: NOT VERIFIED \u2014 all bot requests failed or were blocked during this run. This does not prove the website blocks AI crawlers or serves an empty page.');
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
  var marketReach        = evidence.marketReach || '';
  var subjectType        = evidence.subjectType || 'business';
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
  var reviewMeasurement  = evidence.reviewMeasurement || {};
  var reviewMeasurementText = 'Trustpilot collection: ' + (reviewMeasurement.trustpilot || 'not measured')
    + '\nGoogle Reviews collection: ' + (reviewMeasurement.googleReviews || 'not measured')
    + '\nAn unavailable result means CHOIVE could not verify the evidence. It does not mean reviews do not exist.';
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

  var subjectScoringRule = subjectType === 'creator'
    ? 'Evaluate a CREATOR. Clarity means a clear topic, format, audience, and identity. Trust means independently verifiable coverage, recognized appearances, credited collaborations, awards, or established platform profiles; customer reviews are not required. Difference means a distinct point of view, expertise, format, or audience promise. Ease means people and AI systems can identify, verify, and find the creator across their official channels.'
    : subjectType === 'personal_brand'
      ? 'Evaluate a PERSONAL BRAND. Clarity means a clear expertise, role, audience, and public identity. Trust means independently verifiable credentials, coverage, appearances, outcomes, or collaborations; customer reviews are required only when the person sells a reviewed service. Difference means a specific and evidenced reason to follow, hire, cite, or choose this person. Ease means the identity and official profiles are easy to find and connect.'
      : subjectType === 'organization'
        ? 'Evaluate an ORGANIZATION. Clarity means a clear mission, activity, people served, and geographic scope. Trust means registrations, governance, named partners, accreditations, independent coverage, or documented outcomes; customer reviews are not a universal requirement. Difference means a distinct mission, method, constituency, or outcome. Ease means people and AI systems can understand, verify, contact, support, or participate in it.'
        : subjectType === 'product'
          ? 'Evaluate a PRODUCT OR SERVICE. Clarity means a precise type, use case, intended user, and availability. Trust means verified user evidence, independent reviews, testing, certifications, documented results, or credible maker evidence. Difference means an evidenced advantage over substitutable products. Ease means a user can understand, compare, obtain, and use it.'
          : 'Evaluate a BUSINESS. Clarity means a precise offer, buyer, category, and market. Trust means independently verifiable reviews, clients, results, credentials, partnerships, or coverage appropriate to its buying process. Difference means an evidenced reason to choose it over substitutes. Ease means a buyer can understand, verify, contact, and purchase or procure it.';

  var prompt = 'SUBJECT:\n'
    + 'Name: ' + name + '\n'
    + 'Category: ' + category + '\n'
    + 'Location: ' + city + '\n'
    + 'Customer reach: ' + (marketReach || 'not supplied') + '\n'
    + 'Subject type: ' + subjectType + '\n'
    + 'Website: ' + website + '\n'
    + 'Description: ' + description + '\n'
    + (knownCompetitors ? '\nKNOWN COMPETITORS (provided by user): ' + knownCompetitors + '\n' : '')
    + '\nINFERRED OFFICIAL SITE: ' + inferredSite
    + '\n\n' + confirmedSignalsSection
    + '\n\nKNOWLEDGE GRAPH:\n' + kgText
    + '\n\nWEBSITE CONTENT:\n' + websiteText
    + '\n\nSEARCH EVIDENCE (grouped by signal type):\n' + searchText
    + '\n\nCOMPETITORS APPEARING IN SEARCH:\n' + competitorText
    // Do not inject the first broad-search page here. It is fetched before the
    // evidence-based category is inferred and may be unrelated (as seen with
    // alueducation.com for a pay-TV platform). The dedicated grounded
    // competitor stage below supplies the verified market rival instead.
    // previousCompetitor deliberately NOT injected — v5 web search finds the
    // real competitor fresh each run. Injecting a prior name biases scoring
    // toward repeating old (potentially wrong) answers.
    + (evidence.competitorDecision ? '\n\nCOMPETITOR DECISION \u2014 MADE BY THE DEDICATED SELECTION STAGE (do not override):\n'
        + (evidence.competitorDecision.realCompetitor
            ? 'competitors[0].name MUST be exactly: ' + evidence.competitorDecision.realCompetitor + ' \u2014 the subject\u2019s true head-to-head market rival (source: ' + evidence.competitorDecision.source + '). Reason: ' + evidence.competitorDecision.reason + ' Its evidence text MUST state honestly whether the AI SELECTION GROUND TRUTH currently names this rival, quoting what AI answered instead if it does not.'
            : 'No true head-to-head rival could be named with confidence. competitors[0] MUST be null; do not substitute an AI-mentioned or familiar company.')
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
    + '\n\nREVIEW COLLECTION STATUS:\n' + reviewMeasurementText
    + '\n\nEVIDENCE SUMMARIES:\n'
    + 'Reviews: '     + (summaries.reviewSummary     || 'No verified review data was collected in this run.') + '\n'
    + 'Reputation: '  + (summaries.reputationSummary || 'No reputation data.') + '\n'
    + 'Authority: '   + (summaries.authoritySummary  || 'No authority data.') + '\n'
    + 'Competitors: ' + (summaries.competitorSummary || 'No competitor data.') + '\n'
    + '\nWEBSITE VISIBLE IN SEARCH: ' + visibilityText
    + '\n\n---\n'
    + 'YOU ARE CHOIVE™ — A DECISION INTELLIGENCE ENGINE.\n\n'
    + 'SUBJECT-SPECIFIC SCORING STANDARD — THIS OVERRIDES GENERIC BUSINESS OR CUSTOMER LANGUAGE BELOW:\n' + subjectScoringRule + '\n\n'
    + 'YOUR ONLY JOB:\n'
    + 'Determine, from evidence, why the relevant audience would or would not choose, use, follow, hire, visit, support, cite, or recommend this subject over realistic alternatives.\n\n'
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
    + 'PILLAR SCORE ISOLATION — ABSOLUTE:\n'
    + 'Calculate Clarity, Trust, Difference, and Ease only from evidence about the subject: its official presence, structured signals, search presence, independent verification, coverage, partnerships, outcomes, credentials, clients or audience proof where relevant. AI recommendation transcripts, provider visibility, competitor identities, competitor scores, and whether another option was recommended must have zero effect on any pillar score, pillar finding, or pillar analysis.\n\n'
    + 'STRICT RULES:\n'
    + '1. Use ONLY the evidence provided above. No prior knowledge. No assumptions.\n'
    + '2. Every score must be justified by specific evidence.\n'
    + '3. If a signal is missing, say it is missing. Do not invent it.\n'
    + '3A. EVIDENCE-AVAILABILITY RULE: "unavailable", "not measured", and "not verified" are not proof that a review, citation, crawler permission, or other signal does not exist. Never convert an unavailable check into "none exist", "no buyer has reviewed", "the site blocks all crawlers", or another factual absence. State exactly that CHOIVE could not verify the signal during this run.\n'
    + '4. Every pillar finding must quote or directly reference specific evidence.\n'
    + '4A. Never claim the subject is the "only vendor", "only company", "unique", "first", "market leader", or "category leader" unless a credible independent source in the supplied evidence explicitly proves that exact claim. Otherwise describe the evidenced distinction precisely without an absolute or superlative.\n'
    + '5. If an AI SELECTION GROUND TRUTH section is present, prefer a business named in those AI responses — but ONLY if it is genuinely in the same category serving the same buyer at the same deal size. If no ground-truth name qualifies (AI often answers new categories with adjacent giants from other industries — those are NOT competitors), select from the search evidence instead. If neither yields one, return null.\n'
    + '6. CRITICAL: It is NOT the same business being diagnosed — never name the subject business or any variation of its name as a competitor\n'
    + '7. CRITICAL: It is NOT a platform, tool, or service that this business measures, diagnoses, audits, or helps businesses appear on — for example, if this business helps clients appear on ChatGPT, then ChatGPT is not a competitor; it is the platform being measured\n'
    + '8. CRITICAL — SAME CATEGORY ONLY: Every competitor in the competitors[] array MUST operate in the same category and serve the same buyer type as the subject. If the subject is B2B, all competitors must be B2B. If the subject sells software to enterprises, do not list consumer products, streaming services, or retail brands — those are NOT competitors. A consumer streaming service is never a competitor of a B2B middleware vendor, even if AI mentioned it frequently. Apply this filter to ALL competitors[] slots — not just the first.\n'
    + 'STEP 0 — INFER REAL CATEGORY FROM EVIDENCE:\n'
    + 'User provided category: "' + category + '" — this may be vague or incorrect.\n'
    + 'Using ONLY the evidence, determine:\n'
    + '1. What exactly is this subject, and what does it offer, create, provide, or represent?\n'
    + '2. Who is the relevant audience: buyers, users, followers, members, beneficiaries, partners, supporters, or employers?\n'
    + '3. What precise category would that audience use to find it?\n'
    + '4. What decision or discovery context applies?\n'
    + 'Set inferredCategory in the JSON. Do not write this as prose.\n\n'
    + 'DECISION ENVIRONMENT — classify first:\n'
    + '- discovery_driven: local, map-based, search-based selection\n'
    + '- comparison_driven: evaluated against alternatives before decision\n'
    + '- authority_driven: selected based on reputation, partnerships, capability\n'
    + '- default_driven: category leader chosen automatically\n\n'
    + 'SCORING — four pillars, each 0-25:\n\n'
    + 'CLARITY (0-25): How precisely and consistently is this subject defined?\n'
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
    + 'RECOMMENDED PLATFORM \u2014 CRITICAL: name one real review or credibility platform only when the supplied evidence shows that buyers or close competitors in this exact category use it. Never infer G2 or Capterra merely from the words software, SaaS, or platform. For enterprise procurement categories such as pay-TV middleware, telecom infrastructure, automotive OEM software, or broadcast technology, prefer named customer case studies, relevant analyst coverage, trade press, awards, and industry-association evidence; return an empty recommendedPlatform when no specific platform is evidenced. Restaurants may use Google Reviews; law firms may use Chambers or Legal 500; hotels may use TripAdvisor and Google \u2014 but category fit must still be supported by the evidence.\n\n'
    + 'DIFFERENCE (0-25): Can someone explain why to choose this over alternatives?\n'
    + '- Score 20-25: specific, unique differentiator clearly stated and easy to repeat\n'
    + '- Score 15-19: real differentiator visible — named niche, named enterprise clients, unique use case\n'
    + '- Score 8-14: differentiator exists but vague or easy to copy\n'
    + '- Score 0-7: completely generic — no niche, no unique clients, no distinct use case\n'
    + '- CRITICAL: when confirmed evidence shows multiple named major clients or partners across the business\'s buyer groups plus a long operating history in a defined niche, the Difference score cannot be below 14\n'
    + '- Required: quote the actual differentiator, or state precisely why none exists\n'
    + '- DIFFERENCE FINDING FORMAT: complete this sentence — "[Business] is the [specific thing] for [specific buyer]"\n'
    + '  If no differentiator exists, complete: "[Business] looks like every other [category] to a buyer"\n'
    + '- Analysis sentence 1: Quote the exact phrase or evidence that shows the differentiator (or its absence)\n'
    + '- Analysis sentence 2: Name the exact sales conversation moment where this difference is won or lost\n\n'
    + 'EASE (0-25): How quickly and confidently can this subject be understood, verified, and acted on?\n'
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
    + 'HEAD-TO-HEAD ROLE: competitors[0] is exclusively the independently verified head-to-head market rival supplied by the dedicated research stage. Never replace it with the most frequent AI recommendation. If the dedicated stage supplied no verified rival, competitors[0] must be null.\n'
    + 'AI RECOMMENDATION ROLE: AI recommendation names come exclusively from recorded platform response transcripts. They remain separate from competitors[0], even when the same company appears in both roles. Never say a market rival was recommended by an AI platform unless that platform\'s recorded answer names it.\n'
    + 'GROUND-TRUTH DISQUALIFICATION: if an AI response names the subject itself, a directory, an adjacent company, or a company serving a different buyer, preserve the transcript but do not relabel that name as a qualified competitor.\n'
    + 'Only name a competitor if ALL of these are true:\n'
    + '1. The head-to-head competitor name appears in current market evidence from the dedicated research stage\n'
    + '2. It is in the exact same category as this business\n'
    + '3. It competes for the same buyer type at the same deal size\n'
    + '4. It is not a directory, review platform, aggregator, or listing site\n'
    + '5. It would realistically appear in the same sales conversation\n'
    + '6. CRITICAL: It is NOT the same business being diagnosed — never name the subject business or any variation of its name as a competitor\n'
    + '7. CRITICAL: It is NOT a platform, tool, or service that this business measures, diagnoses, audits, or helps businesses appear on — for example, if this business helps clients appear on ChatGPT, then ChatGPT is not a competitor; it is the platform being measured\n'
    + 'If no competitor meets every criterion, return null. Never name a familiar company from model memory merely to fill the field.\n\n'
    + (knownCompetitors ? ('IF THE USER PROVIDED KNOWN COMPETITORS:\n'
    + 'Treat each name as an owner-supplied claim that must be checked, not as verified ground truth. For each name in that list:\n'
    + '1. Search the evidence above for any mention of that name, even a brief one.\n'
    + '2. If found anywhere in the evidence, include it as a competitor.\n'
    + '3. Include it only when current evidence also confirms the same product, buyer, commercial model, and serviceable market.\n'
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
    + 'whyAIRecommendsThem: if recorded AI responses name this competitor, state what those responses actually said. If the competitor comes only from market evidence, say "Not established as an AI recommendation in this run" and do not infer a reason.\n'
    + 'advantage: one sentence — what structural competitive advantage does this competitor hold over the subject business specifically? Focus on what they have that the subject lacks — review volume, category positioning, brand recognition, trust signals — NOT on why AI names them (that is already covered above).\n'
    + 'gapLocation: identify a buying moment only when a recorded query demonstrates it. Otherwise say that no AI displacement moment was measured.\n'
    + 'closeGap: name one evidence improvement supported by the subject\'s missing signals. Do not promise that it will change an AI answer.\n'
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
    + '- ACTION TRACEABILITY: Sentence 1 of every action body must name the exact observation that triggered it: a measured query and platform answer, a confirmed page element, a named source, or a missing public signal. Sentence 2 must state the exact deliverable to create or change. Sentence 3 must state how completion will be verified. Never tell the reader only to "improve visibility", "strengthen trust", "optimize presence", "build authority", or "close the gap".\n'
    + '- ACTION LENGTH: Use exactly 3 short sentences in each action body and no more than 75 words total. Keep explanation and if_nothing to no more than 45 words each.\n'
    + '- ACTION OWNERSHIP: When the evidence supports it, name the practical owner such as website team, communications lead, product marketing lead, or founder. Do not invent a person or job title that the evidence does not establish.\n'
    + '- PLAIN LANGUAGE: Reader-facing text must explain the concrete event, evidence, consequence, and action. Avoid abstract labels unless the following words define them. Never use "chosen by AI", "known by AI", "AI-ready", "selection infrastructure", "trust signals", or "visibility gap" without immediately stating the measured answer or missing evidence in plain language.\n'
    + '- SEQUENCE: actions must be ordered by what unlocks what — fixing trust before ease, clarity before difference\n'
    + '- NUMERIC TARGETS: review counts, publication counts, timelines, and similar numbers may be proposed as practical goals, but never call them an AI-system minimum, required threshold, guaranteed trigger, or industry standard unless the supplied evidence contains a credible source establishing that exact threshold.\n'
    + '- REAL ENTITIES ONLY: never name a company, platform, or service in actions or plans unless you are confident it is currently operating. If an entity from search evidence may be defunct or unrecognisable, omit the name entirely.\n'
    + '- COMMUNITY OPPORTUNITY: use this action only when the evidence contains a real conversation specifically about the same product category and written by a plausible buyer. Generic career, software architecture, entrepreneurship, or broad vendor-evaluation threads do not qualify. When a qualifying thread exists, ONE action may be tactical, disclosed engagement in that exact conversation \u2014 name the platform and reference what the thread is actually asking. If no qualifying buyer conversation was found, omit this action type entirely. Any founder, employee, agency, or representative must disclose their relationship clearly and follow the platform\'s self-promotion rules. Never advise posing as an unaffiliated customer, hiding a commercial connection, using a personal account to evade disclosure, or adding an unverified discount code.\n\n'
    + 'PILLAR FINDINGS — USE THESE EXACT FORMATS:\n'
    + 'Clarity finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Trust finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Difference finding: [one short phrase, max 6 words, no punctuation]\n'
    + 'Ease finding: [one short phrase, max 6 words, no punctuation]\n\n'
    + 'PILLAR ANALYSIS — exactly 2 sentences each:\n'
    + 'Sentence 1: Quote or directly reference the specific evidence. Name exact numbers, platforms, signals found or missing.\n'
    + 'Sentence 2: State the exact selection consequence — what a buyer experiences because of this score.\n'
    + 'Each sentence must contain no more than 24 words.\n'
    + 'NEVER write generic analysis. Every sentence must be impossible to apply to a different business.\n\n'
    + 'VERDICT HEADLINE \u2014 max 10 words, no punctuation, strategic advisor tone. '
    + 'AVOID AMBIGUOUS NEGATION: never write "not consistently [positive thing]" or "not always [positive thing]" \u2014 a reader can misparse this as mostly-positive-with-exceptions when the true meaning is the opposite. BANNED EXAMPLE: "Not consistently the obvious choice" (reads as usually chosen, sometimes not \u2014 backwards for a weak/absent tier). Instead state the gap plainly and unambiguously: "Overlooked when it matters most", "Not the default choice yet", "Invisible at the moment of comparison".\n\n'
    + 'SIGNATURE LINE \u2014 one short factual sentence grounded in the recorded measurement. State what happened using "mentioned" or "recommended". Never use "chosen", "choice", "present", or an unexplained metaphor.\n'
    + 'MARKET POSITION \u2014 return tier, a plain-language label, and one evidence-based explanation. The label must state the position directly; never return "Unknown position" when a tier was established.\n\n'
    + 'Use only these values: verdictLevel = absent, weak, or present; decisionState = not_seen, seen_not_considered, considered_not_chosen, trusted_not_chosen, or chosen_by_default; decisionEnvironment = discovery_driven, comparison_driven, authority_driven, or default_driven. These are internal codes only and must not appear in reader-facing prose.\n\n'
    + 'SUMMARY PARAGRAPH — exactly 3 sentences, no more than 65 words total:\n'
    + 'DISPLACEMENT SUMMARY RULE — choose exactly one opening based on this priority order:\n'
    + '  1. If the AI SELECTION GROUND TRUTH section names a specific competitor (displacement detected): Sentence 1 MUST be: "When buyers ask AI which [category] to choose in [location/market], [Competitor] is recommended — not [Business Name]."\n'
    + '  2. If recorded platform answers recommend the subject AND no displacement competitor was named: Sentence 1 states exactly which recorded platforms recommended it.\n'
    + '  3. Otherwise: Sentence 1 states exactly how many completed discovery questions mentioned the subject. Never infer recommendation from market tier or pillar score.\n'
    + 'Apply only ONE of these openings. Do not blend them.\n'
    + '- Sentence 2: the single strongest evidence-based driver or gap — name the specific signal or its absence\n'
    + '- Sentence 3: the concrete moment in the buyer journey where this business is lost or won. Name the exact moment.\n\n'
    + 'SUBJECT UNDERSTANDING — what AI currently thinks this subject is:\n'
    + 'Write exactly two paragraphs separated by a blank line.\n'
    + 'Each paragraph must contain no more than 55 words. Use sentences of no more than 22 words.\n'
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
    + 'Write 4 to 6 short sentences and no more than 110 words total. Each sentence must communicate one finding only.\n'
    + 'LEAD WITH THE AI FINDING: If the AI SELECTION GROUND TRUTH section names a specific competitor, the evidence narrative MUST open with that fact: "Real AI recommendation queries for [category] in [location] returned [Competitor] as the named answer — [Business] was not mentioned." This is the most important finding in the entire report and must never be buried.\n'
    + 'Write exactly what was found and what was not found. Name specific search queries that returned zero results.\n'
    + 'Name specific signals that were confirmed. Name the exact gap between what exists and what is needed.\n'
    + 'Do not summarise. Do not soften. Do not generalise. Every sentence must be evidence-backed.\n\n'
    + 'REPORT WRITING STANDARD — apply this to every narrative, finding, action, and explanation:\n'
    + '- Use plain language and short sentences. One sentence should communicate one idea.\n'
    + '- State the measured fact first, then its practical meaning. Never hide the conclusion behind introductory wording.\n'
    + '- Avoid vague words such as improve, optimize, strengthen, enhance, establish, leverage, visibility, authority, positioning, or trust unless the same sentence states the exact object, location, and proof required.\n'
    + '- Every action body must state: what must change, where it must change, and what observable evidence proves completion.\n'
    + '- Never promise selection, revenue, rankings, a future score, or a platform response.\n'
    + '- Keep summaryParagraph, businessUnderstanding, and evidenceNarrative to a maximum of 120 words each. Keep findings to 24 words and action bodies to 70 words.\n'
    + '- Write for a business owner without technical training. Define technical terms in the sentence where they first appear.\n\n'
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
    + 'READY-TO-USE ASSETS — write business-specific copy using ONLY facts explicitly present in the owner input or collected evidence.\n'
    + 'Create 2 or 3 homepage H1 options. Each must plainly name the offer/category and intended buyer or use case; include the service market only when relevant. Keep each between 45 and 115 characters.\n'
    + 'Also return structured llmsFacts: a factual one-sentence summary, concrete offers, intended audiences, service area, and published distinctions. Empty arrays are correct when evidence is missing.\n'
    + 'Never invent or imply leadership, quality, popularity, trust, awards, certifications, outcomes, clients, availability, or locations. Avoid vague phrases such as "built for results", "where every detail matters", "solutions that stand out", and "teams trust".\n\n'
    + 'Respond with ONLY the following JSON object. No prose. No markdown. Start with { and end with }.\n\n';

  var jsonSchema = '{\n'
    + '  "overallScore": 0,\n'
    + '  "verdictHeadline": "",\n'
    + '  "verdictLevel": "",\n'
    + '  "signatureLine": "",\n'
    + '  "decisionState": "",\n'
    + '  "decisionEnvironment": "",\n'
    + '  "summaryParagraph": "",\n'
    + '  "businessUnderstanding": "",\n'
    + '  "evidenceNarrative": "",\n'
    + '  "inferredCategory": "",\n'
    + '  "marketPosition": { "tier": "", "label": "", "explanation": "" },\n'
    + '  "platformCoverage": { "chatgpt": "weak", "perplexity": "weak", "gemini": "weak", "claude": "weak" },\n'
    + '  "recommendedPlatform": { "name": "", "url": "", "reason": "" },\n'
    + '  "readyToUseAssets": {\n'
    + '    "h1Options": ["", ""],\n'
    + '    "llmsFacts": { "summary": "", "offers": [], "audiences": [], "serviceArea": "", "distinctions": [] }\n'
    + '  },\n'
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
  var recommendationGuard = evidence.competitorDecision && !evidence.competitorDecision.aiRecommends
    ? 'ABSOLUTE RECOMMENDATION GUARD: No company met the cross-query consistency threshold in the recorded Claude samples. Do not say any company is recommended instead of the subject, do not describe any company as the AI/Claude selection leader, and do not create displacement language in the summary, evidence narrative, actions, or competitor cards. You may still discuss the verified head-to-head market competitor, but label it as market analysis only.\n\n'
    : '';
  return prompt + recommendationGuard + competitorReminder + jsonSchema;
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
    if ((s.allBotsFailed || s.botCrawlable === false) && p.ease.score > 3) { p.ease.score = 3; }
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

    // CLARITY — H1 relevance remains an interpreted check. Mechanical H1
    // presence is recorded separately and must not be mistaken for proof that
    // the headline actually names the product or service.
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
    }
    if (s.trustpilotRating && s.trustpilotReviewCount) {
      overrideSignal('trust', 'Trustpilot', 'pass', s.trustpilotRating + '/5 · ' + s.trustpilotReviewCount + ' reviews');
    } else if (s.trustpilotRating) {
      overrideSignal('trust', 'Trustpilot', 'partial', s.trustpilotRating + '/5 · review count not confirmed');
    }

    // EASE — schema, llms.txt, bot crawlability
    if (s.hasSchema) {
      var schemaTypes = Array.isArray(s.schemaTypes) ? s.schemaTypes.filter(Boolean) : [];
      var schemaDetail = schemaTypes.length
        ? (schemaTypes.length + ' schema type' + (schemaTypes.length > 1 ? 's' : '') + ': ' + schemaTypes.join(', '))
        : ((s.schemaCount && s.schemaCount > 0)
          ? (s.schemaCount + ' JSON-LD block' + (s.schemaCount > 1 ? 's' : '') + ' detected')
          : 'Schema markup detected');
      overrideSignal('ease', 'Schema markup', 'pass', schemaDetail);
    } else {
      overrideSignal('ease', 'Schema markup', 'fail', 'No JSON-LD or schema detected');
    }
    if (s.hasLlmsTxt) {
      overrideSignal('ease', 'llms.txt file', 'pass', 'llms.txt confirmed at root');
    } else {
      overrideSignal('ease', 'llms.txt file', 'fail', 'No llms.txt found');
    }
    if (s.botCrawlable === null || s.botCrawlable === undefined) {
      overrideSignal('ease', 'AI crawlers can read page', 'partial', 'Crawler access was not measured');
    } else if (s.botEmptyShellDetected) {
      overrideSignal('ease', 'AI crawlers can read page', 'fail', 'Bots see empty shell — JS-only render');
    } else if (s.allBotsFailed) {
      overrideSignal('ease', 'AI crawlers can read page', 'partial', 'CHOIVE could not verify crawler access because all bot requests failed or were blocked');
    } else if (s.botCrawlable === false) {
      overrideSignal('ease', 'AI crawlers can read page', 'partial', 'Partial content visible to bots');
    } else if (s.botCrawlable === true) {
      overrideSignal('ease', 'AI crawlers can read page', 'pass', 'Bots see substantive page content');
    } else {
      overrideSignal('ease', 'AI crawlers can read page', 'fail', 'Crawler access failed');
    }
  }

  return rawOutput;
}

// ── Safe output normalizer ────────────────────────────────────────────────────
function safeOutput(raw) {
  var r = raw || {};
  var pillars = r.pillars || {};
  function moderateAbsoluteClaims(value) {
    return String(value || '')
      .replace(/\bthe only vendor\b/gi, 'a distinctive vendor')
      .replace(/\bonly vendor\b/gi, 'distinctive vendor')
      .replace(/\bthe only company\b/gi, 'a distinctive company')
      .replace(/\bonly company\b/gi, 'distinctive company')
      .replace(/\bmarket leader\b/gi, 'established market participant')
      .replace(/\bcategory leader\b/gi, 'established category participant');
  }
  function safePillar(p) {
    p = p || {};
    return {
      score: Number(p.score) || 0,
      finding: moderateAbsoluteClaims(p.finding),
      analysis: moderateAbsoluteClaims(p.analysis),
      evidence: p.evidence || ''
    };
  }
  var supportedPlatform = (r.recommendedPlatform && r.recommendedPlatform.name) ? r.recommendedPlatform : null;
  var actions = Array.isArray(r.actions) ? r.actions : [];
  if (!supportedPlatform) {
    actions = actions.filter(function(action) {
      var text = [action && action.title, action && action.body, action && action.explanation].join(' ');
      return !/\b(create|claim|join|list(?:ing)?)\b[^.]{0,80}\b(g2|capterra|trustpilot|trustradius|clutch)\b/i.test(text);
    });
  }
  return {
    overallScore:          Number(r.overallScore) || 0,
    verdictHeadline:       r.verdictHeadline      || '',
    verdictLevel:          r.verdictLevel         || '',
    decisionState:         r.decisionState        || '',
    decisionEnvironment:   r.decisionEnvironment  || '',
    summaryParagraph:      moderateAbsoluteClaims(r.summaryParagraph),
    businessUnderstanding: moderateAbsoluteClaims(r.businessUnderstanding),
    evidenceNarrative:     moderateAbsoluteClaims(r.evidenceNarrative),
    inferredCategory:      r.inferredCategory     || '',
    signatureLine:         r.signatureLine        || '',
    marketPosition:        r.marketPosition       || { tier: 'unknown', reasoning: '' },
    platformCoverage:      r.platformCoverage     || { chatgpt: 'weak', perplexity: 'weak', gemini: 'weak', claude: 'weak' },
    selectionGap:          r.selectionGap         || 0,
    recommendedPlatform:   supportedPlatform,
    pillars: {
      clarity:    safePillar(pillars.clarity),
      trust:      safePillar(pillars.trust),
      difference: safePillar(pillars.difference),
      ease:       safePillar(pillars.ease)
    },
    signalAudit: (r.signalAudit && typeof r.signalAudit === 'object') ? r.signalAudit : { clarity: [], trust: [], difference: [], ease: [] },
    competitors:  Array.isArray(r.competitors) ? r.competitors.filter(function(c) { return c && c.name; }) : [],
    competitor:   r.competitor  || null,
    actions:      actions,
    readyToUseAssets: (r.readyToUseAssets && typeof r.readyToUseAssets === 'object') ? r.readyToUseAssets : null,
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
  // previousCompetitor deliberately excluded — it had unfair prior weight
  // that caused old wrong competitors to persist. Frequency is measured fresh.

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
  var name     = String(evidence.name     || '').trim();
  var category = String(evidence.category || '').trim();
  var inferred = String(evidence.inferredCategory || category).trim();
  var known    = String(evidence.knownCompetitors || '').trim();
  var siteText = sanitizeExternal(String(evidence.websiteText || '')).slice(0, 1200);
  var website  = String(evidence.website  || '').trim();
  var city     = String(evidence.city     || '').trim();
  var marketReach = String(evidence.marketReach || '').trim();
  var subjectType = String(evidence.subjectType || 'business').trim();
  var kgText   = sanitizeExternal(String((evidence.kgText || '')).replace(/^None$/i, '')).slice(0, 400);

  // AI SELECTION GROUND TRUTH — who AI actually recommended in buyer queries
  var simBefore = evidence.aiSimulationBefore || null;
  var groundTruth = '';
  var aiNamedCompetitors = [];
  if (simBefore && simBefore.before && Array.isArray(simBefore.before.results)) {
    groundTruth = simBefore.before.results.map(function(r, i) {
      return 'QUERY ' + (i + 1) + ': "' + String(r.query || '') + '"\nAI ANSWERED: '
        + sanitizeExternal(String(r.response || '')).slice(0, 800);
    }).join('\n\n');
  }

  // Search evidence competitors — who appeared in Serper results
  var searchComps = (evidence.competitors || []).map(function(c) {
    return String(c.name || c.domain || '');
  }).filter(Boolean).slice(0, 8).join(', ');

  // ── DIRECT COMPETITOR IDENTIFICATION WITH WEB SEARCH ───────────────────
  // This is the core change: instead of counting frequency of names in AI
  // buyer query responses (which surfaces whoever ranks in search, not real
  // competitors), we ask Claude with web search to reason about the business
  // and identify true head-to-head rivals — the same way a knowledgeable
  // industry analyst would answer "who does this company compete with?"
  //
  // This stage identifies the head-to-head market rival. It does not decide
  // who Claude recommended in the simulations; that is measured separately.
  var prompt = 'You are a competitive intelligence analyst. Your task is to identify the TRUE head-to-head competitors of a specific business.\n\n'
    + 'SUBJECT BUSINESS:\n'
    + 'Name: ' + name + (website ? ' (' + website + ')' : '') + '\n'
    + 'Inferred category: ' + inferred + '\n'
    + 'Subject type: ' + subjectType + '\n'
    + (city ? 'Headquarters / base location: ' + city + '\n' : '')
    + (marketReach ? 'CUSTOMER REACH (owner selected; authoritative): ' + marketReach + '\n' : '')
    + (siteText ? 'Website content (what they actually sell and who buys it):\n' + siteText + '\n' : '')
    + (kgText ? 'Knowledge graph: ' + kgText + '\n' : '')
    + (known ? 'Competitors named by the owner: ' + known + '\n' : '')
    + (searchComps ? 'Companies appearing in related search evidence: ' + searchComps + '\n' : '')
    + (groundTruth ? 'What AI currently recommends when buyers search for this category:\n' + groundTruth + '\n' : '')
    + '\n'
    + 'YOUR TASK:\n'
    + 'Using only the supplied website, search, simulation evidence, and live searches performed in this call, identify this subject\'s real competitors or closest alternatives. Never fill a missing answer from model memory:\n\n'
    + (subjectType === 'creator' || subjectType === 'personal_brand'
        ? 'CREATOR/PERSON FIT RULE: compare only active people with the same core topic or expertise, substantially overlapping audience, comparable role or content format, and the same geographic reach. Do not require them to sell a product. When the use case is hiring, sponsorship, speaking, or collaboration, require the same buyer and engagement type.\n\n'
        : subjectType === 'organization'
        ? 'ORGANIZATION FIT RULE: compare only active organizations with the same core mission or activity, substantially overlapping audience or beneficiaries, comparable operating model, and the same geographic reach. Do not force a commercial purchasing model onto a non-commercial organization.\n\n'
        : '')
    + 'STEP 1 — SEARCH WITH TIER MATCHING:\n'
    + '  Search using the BUYER TIER, not just the product category. If the subject has named enterprise clients, search for who serves those same clients.\n'
    + '  Build search terms from the subject evidence. Do not begin with a list of candidate companies.\n'
    + '  CRITICAL TIER RULE — applies to every business category:\n'
    + '  Look at NAMED CLIENTS, DEAL SIZE, and STAFF COUNT in the evidence to identify the competitive tier. Search for competitors at that exact tier.\n'
    + '  Examples by category and tier:\n'
    + '  Accounting firm with FTSE 100 clients: search "Big Four accounting competitor UK FTSE 100". Local bookkeeper: search "bookkeeper small business competitor [city]".\n'
    + '  Law firm doing multinational M and A: search "Magic Circle law firm competitor". Local property solicitor: search "property solicitor competitor [city]".\n'
    + '  5-star hotel with celebrity guests: search "luxury 5-star hotel competitor [city]". Budget hostel: search "budget hostel competitor [city]".\n'
    + '  Restaurant with Michelin stars: search "Michelin star restaurant competitor [city]". Local pizza place: search "pizza restaurant competitor [city]".\n'
    + '  SaaS with Fortune 500 clients: search "enterprise [category] software competitor Fortune 500". SaaS for startups: search "[category] startup tool competitor".\n'
    + '  The tier anchor is always the named clients or evidence signals, never the generic category name.\n\n'
    + 'STEP 2 — SEARCH FOR COMPARISONS: search "[subject name] vs" or "[subject name] alternative" or "[subject name] competitor" — comparison pages explicitly name who buyers evaluate side by side.\n\n'
    + 'STEP 3 — CHECK INDEPENDENT CATEGORY SOURCES: use trade publications, analyst sources, professional directories, review platforms, or buyer guides that are demonstrably relevant to this exact category. Do not default to a software-review site, consumer-review site, or directory without evidence that buyers in this category use it.\n\n'
    + 'STEP 4 — EVALUATE ALL CANDIDATES against the three strict tests below. Only accept companies that pass all three.\n\n'
    + 'THREE STRICT TESTS — a candidate must pass ALL THREE:\n'
    + '1. SAME PRODUCT TYPE: sells the same type of product or service (not just adjacent or complementary)\n'
    + '2. SAME BUYER: the same person spends the money (same buyer role, same company type, same deal size)\n'
    + '3. SAME COMMERCIAL MODEL: both license software, or both sell direct-to-consumer, or both offer managed services — not mixed models\n\n'
    + '4. SAME SERVICEABLE MARKET: use the owner-selected CUSTOMER REACH as authoritative. Local means the same city or realistic nearby catchment; regional means the same region; national means available throughout the same country; international means available across the subject\'s served countries; global means worldwide competitors are eligible. Headquarters alone never proves market eligibility. Reject any company buyers in the subject\'s market cannot actually choose.\n\n'
    + 'CRITICAL BUSINESS MODEL RULE — apply before anything else:\n'
    + 'If the inferred category says the business OWNS its production (farm brand, own herd, own factory, vertically-integrated, direct from farm): its competitors MUST ALSO own their own production and sell direct. A retailer that sources from multiple farms is NOT a true competitor to a farm brand — the buying decision is fundamentally different.\n'
    + 'For an own-production subject, accept a candidate only when supplied evidence or a current source found in this call explicitly confirms that the candidate owns the relevant farm, factory, workshop, or production operation. If ownership is unclear, reject the candidate.\n'
    + 'A farm brand\'s real competitor is another farm-direct brand, not a premium retailer. Look for competitors that own their animals/production and sell under their own brand.\n'
    + '\n'
    + 'WHAT TO EXCLUDE:\n'
    + '- Companies that BUY or USE this product (they are customers, not competitors)\n'
    + '- Consumer products when the subject sells business infrastructure or enterprise software\n'
    + '- Business software when the subject sells a consumer product or local consumer service\n'
    + '- Companies serving a different buyer size, use case, or procurement process\n'
    + '- Operators, retailers, or distributors that buy or resell the subject\'s product but do not sell the same offer under the same commercial model\n'
    + '- Multi-brand retailers when the subject owns its production, and producers when the subject is purely a multi-brand retailer\n'
    + '- Companies in a different part of the value chain (distributors, infrastructure providers, content owners)\n'
    + '- Review platforms, directories, aggregators\n'
    + '- The subject business itself, including its website domain, abbreviation, translated name, legal name, or any name variant\n'
    + '- Companies that merely appear in search results but serve a different buyer or different use case\n\n'
    + 'GEOGRAPHIC SCOPE: match where the BUYERS are, not where the business is headquartered.\n'
    + 'If the business serves global or regional enterprise clients (e.g. telcos in multiple countries), competitors from any country serving the same buyer type qualify.\n'
    + 'If the business serves local consumers (e.g. restaurant, local clinic), only local competitors qualify.\n\n'
    + 'CANDIDATE DISCOVERY: discover candidates from the subject evidence and independent searches only. Do not prefer a company because it appeared in a previous report, prompt example, or model answer.\n\n'
    + 'COMPETITOR IDENTITY: return the exact current public brand name used by the company itself. Do not translate it, shorten it into a guessed domain, or construct a new name from category words. A descriptive domain and a public brand may differ; prefer the verified public brand, and leave the result null when the identity cannot be established reliably. If a competing product was transferred, merged, or rebranded, name the current vendor that now sells and contracts for that product. Do not use a legacy product owner merely because its separate services business still operates; match the entity to the actual purchasing decision being analysed.\n\n'
    + 'PRODUCE THREE ANSWERS:\n'
    + 'A — realCompetitor: the single most direct head-to-head rival. The company a buyer would most naturally compare this business against in a deal. Must be a CURRENTLY OPERATING named company.\n'
    + 'TIEBREAKER RULE: use popularity signals only after candidates have independently passed every product, buyer, commercial-model, production-ownership, tier, and geography test. Review volume or search presence can never compensate for a failed or unverified business-model match. Among equally valid candidates, prefer (1) more third-party review volume, (2) longer market presence, (3) stronger search presence — in that order.\n'
    + 'B — aiRecommends: the company AI most prominently names when buyers search for this category right now. Apply the SAME TIEBREAKER RULE as Answer A: if multiple names appear, prefer the one with more third-party review volume, then longer market presence. May be the same as realCompetitor or different.\n'
    + 'C — secondAiCompetitor: the SECOND company AI names in buyer queries for this category — different from both realCompetitor and aiRecommends. Apply the SAME TIEBREAKER RULE. Use an empty string if no clear second name exists.\n'
    + 'D — globalBenchmark: if applicable, the dominant global market leader in this category (may not serve the exact same geographic market but sets the standard buyers compare against). Use an empty string if it is the same as realCompetitor or aiRecommends.\n\n'
    + 'TIEBREAKER FOR ALL ANSWERS: when multiple candidates qualify, prefer (1) more third-party review volume, (2) longer market presence, (3) stronger search/analyst presence.\n\n'
    + 'IMPORTANT: Only return a company when supplied evidence or a current source found in this call confirms that it operates now and passes every required test. Otherwise return an empty string. Use its current public name only when that identity is confirmed. For realCompetitor, sourceUrls must contain 1-3 current URLs that directly support the same-product, same-buyer, and same-commercial-model match. If no supporting URL is available, realCompetitor must be empty.\n\n'
    + 'Respond with exactly this JSON — no markdown, no preamble:\n'
    + '{"realCompetitor":"<name or empty string>","aiRecommends":"<name or empty string>","secondAiCompetitor":"<name or empty string>","globalBenchmark":"<name or empty string>","sourceUrls":["https://current-supporting-source.example"],"source":"evidence_analysis","categoryUnowned":<true|false>,"contested":<true|false>,"reason":"<one sentence explaining why realCompetitor is the true rival>"}';

  var controller = new AbortController();
  // Grounded competitor research commonly needs more than 30 seconds,
  // especially when the provider pauses a turn while web search completes.
  // A 30-second abort produced valid recommendation lanes but a null
  // head-to-head competitor. The background function has a 15-minute budget,
  // so allow this accuracy-critical stage to finish.
  var timer = setTimeout(function() { controller.abort(); }, 75000);
  try {
    var selectionRequest = {
      model: ANTHROPIC_MODEL,
      max_tokens: 1400,
      temperature: 0,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              realCompetitor: { type: 'string' },
              aiRecommends: { type: 'string' },
              secondAiCompetitor: { type: 'string' },
              globalBenchmark: { type: 'string' },
              sourceUrls: { type: 'array', items: { type: 'string' } },
              source: { type: 'string' },
              categoryUnowned: { type: 'boolean' },
              contested: { type: 'boolean' },
              reason: { type: 'string' }
            },
            required: [
              'realCompetitor',
              'aiRecommends',
              'secondAiCompetitor',
              'globalBenchmark',
              'sourceUrls',
              'source',
              'categoryUnowned',
              'contested',
              'reason'
            ],
            additionalProperties: false
          }
        }
      }
    };
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(selectionRequest),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      var errData = await res.json().catch(function() { return {}; });
      console.warn('[competitor-selection] API error:', res.status, errData.error && errData.error.message);
      return null;
    }
    var data = await res.json();
    logAnthropicUsage('head-to-head-research', data);
    // Server-side web search can pause a long-running turn. Continue that same
    // turn once, preserving its tool state, instead of trying to parse the
    // preliminary "I'll research..." text as the final structured result.
    if (data.stop_reason === 'pause_turn') {
      var continuationController = new AbortController();
      var continuationTimer = setTimeout(function() { continuationController.abort(); }, 75000);
      selectionRequest.messages = [
        { role: 'user', content: prompt },
        { role: 'assistant', content: data.content || [] }
      ];
      var continuation = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(selectionRequest),
        signal: continuationController.signal
      });
      clearTimeout(continuationTimer);
      if (!continuation.ok) {
        var continuationError = await continuation.json().catch(function() { return {}; });
        console.warn('[competitor-selection] continuation API error:', continuation.status, continuationError.error && continuationError.error.message);
        return null;
      }
      data = await continuation.json();
      logAnthropicUsage('head-to-head-research-continuation', data);
    }
    if (data.stop_reason === 'max_tokens') {
      console.warn('[competitor-selection] structured response reached max_tokens');
      return null;
    }
    // Extract text from response — may include tool_use blocks from web search
    var text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; })
      .join('').replace(/```json|```/g, '').trim();
    if (!text) {
      console.warn('[competitor-selection] no text in response');
      return null;
    }
    var fi = text.indexOf('{'), li = text.lastIndexOf('}');
    var jsonText = (fi !== -1 && li > fi) ? text.slice(fi, li + 1) : text;
    var parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object') return null;
    var sourceUrls = Array.isArray(parsed.sourceUrls)
      ? parsed.sourceUrls.map(function(v) { return String(v || '').trim(); })
          .filter(function(v) { return /^https?:\/\/[^\s]+$/i.test(v); }).slice(0, 3)
      : [];
    function cleanName(v) {
      var s = v ? String(v).trim() : '';
      if (!s || s === 'null') return null;
      var normS = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      var normN = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      // Exact match
      if (normN && normS === normN) return null;
      // Prefix match
      if (normN && normS && normN.length >= 4 && normS.length >= 4) {
        if (normS.startsWith(normN) || normN.startsWith(normS)) return null;
      }
      // Abbreviation check — e.g. "3SS" is abbreviation of "3 screens solutions"
      // Build initials from name words: "3 screens solutions" → "3ss"
      var nameInitials = normN.split(/\s+/).map(function(w) { return w[0] || ''; }).join('');
      var candidateCompact = normS.replace(/\s+/g, '');
      if (nameInitials.length >= 2 && candidateCompact === nameInitials) return null;
      // Also check if candidate matches domain core (e.g. "3ss" from "3ss.tv")
      if (website) {
        var domainCore = website.toLowerCase()
          .replace(/^https?:\/\//, '').replace(/^www\./, '')
          .split('/')[0].replace(/\.[^.]+$/, '');
        if (domainCore && (candidateCompact === domainCore || normS.replace(/\s/g,'') === domainCore)) return null;
        // Also reject if candidate IS the domain with TLD
        var fullDomain = website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
        if (normS.replace(/\s/g,'') === fullDomain.replace(/\./g,'')) return null;
      }
      return s;
    }
    var verifiedRealCompetitor = cleanName(parsed.realCompetitor);
    if (verifiedRealCompetitor && sourceUrls.length === 0) {
      console.warn('[competitor-selection] rejected head-to-head name without a supporting source URL:', verifiedRealCompetitor);
      verifiedRealCompetitor = null;
    }
    var result = {
      selectionVersion:   5, // v5: direct web search competitor identification
      realCompetitor:     verifiedRealCompetitor,
      aiRecommends:       cleanName(parsed.aiRecommends),
      secondAiCompetitor: cleanName(parsed.secondAiCompetitor),
      globalBenchmark:    cleanName(parsed.globalBenchmark),
      source:             'evidence_analysis',
      sourceUrls:         sourceUrls,
      categoryUnowned:    parsed.categoryUnowned === true,
      contested:          parsed.contested === true,
      frequencyTable:     [], // not used in v5
      reason:             String(parsed.reason || '').slice(0, 300)
    };
    console.log('[competitor-selection v5] real: ' + (result.realCompetitor || 'none')
      + ' | AI names: ' + (result.aiRecommends || 'none')
      + ' | AI second: ' + (result.secondAiCompetitor || 'none')
      + ' | benchmark: ' + (result.globalBenchmark || 'none')
      + (result.categoryUnowned ? ' | category UNOWNED' : '')
      + ' — ' + result.reason);
    return result;
  } catch (err) {
    clearTimeout(timer);
    console.warn('[competitor-selection] web search call failed:', err.message);
    return null;
  }
 } catch (outerErr) {
  console.warn('[competitor-selection] outer stage error:', outerErr.message);
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
    // Skip selectDominantCompetitor ONLY on a scoring retry within the same run.
    // A prior run's competitor decision (v4 or earlier) must NEVER be reused —
    // v5 uses web search to find the real competitor fresh every time.
    // The only valid skip is when competitorDecision was already set to v5
    // in this exact run's evidence object (i.e. we're retrying the Claude
    // scoring call after a timeout, not starting a new diagnostic).
    var isCurrentRunV5 = existingDecision
      && existingDecision.realCompetitor
      && existingDecision.selectionVersion === 5;
    var measuredDecision = existingDecision && existingDecision.selectionVersion < 5
      ? existingDecision
      : null;
    var compDecision = isCurrentRunV5
      ? existingDecision
      : await selectDominantCompetitor(evidence);
    if (compDecision) {
      // Web research determines the market rival only. Recommendation leaders
      // must remain grounded in the recorded Claude simulation transcripts.
      if (measuredDecision) {
        compDecision.aiRecommends = measuredDecision.aiRecommends || null;
        compDecision.secondAiCompetitor = measuredDecision.secondAiCompetitor || null;
        compDecision.mentionCount = measuredDecision.mentionCount || 0;
        compDecision.secondMentionCount = measuredDecision.secondMentionCount || 0;
        compDecision.distinctQueryCount = measuredDecision.distinctQueryCount || 0;
        compDecision.secondDistinctQueryCount = measuredDecision.secondDistinctQueryCount || 0;
        compDecision.aiMentionedCompetitor = measuredDecision.aiMentionedCompetitor || null;
        compDecision.secondAiMentionedCompetitor = measuredDecision.secondAiMentionedCompetitor || null;
        compDecision.aiMentionedCount = measuredDecision.aiMentionedCount || 0;
        compDecision.secondAiMentionedCount = measuredDecision.secondAiMentionedCount || 0;
        compDecision.aiMentionedQueryCount = measuredDecision.aiMentionedQueryCount || 0;
        compDecision.secondAiMentionedQueryCount = measuredDecision.secondAiMentionedQueryCount || 0;
        compDecision.totalResponses = measuredDecision.totalResponses || 0;
        compDecision.totalQueries = measuredDecision.totalQueries || 0;
        compDecision.recommendationSource = measuredDecision.source || null;
      } else {
        compDecision.aiRecommends = null;
        compDecision.secondAiCompetitor = null;
      }
      // "Category unowned" describes the measured AI recommendation space,
      // not whether market rivals exist. It cannot coexist with a
      // transcript-verified qualifying AI recommendation, but it may coexist
      // with a market rival that the measured AI answers did not name.
      if (compDecision.aiRecommends) {
        compDecision.categoryUnowned = false;
      }
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
    logAnthropicUsage('four-pillar-scoring', data);
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
  var marketReach = String(evidence.marketReach || '').trim();

  var candidateLines = (channelResults.competitors || []).map(function(c) {
    return '- ' + (c.domain || '') + (c.title ? ' ("' + c.title.slice(0, 70) + '")' : '');
  }).filter(Boolean).slice(0, 8).join('\n');

  var searchExcerpt = sanitizeExternal(String(channelResults.searchText || '')).slice(0, 2000);

  if (!candidateLines && !searchExcerpt) return null;

  var prompt = 'You identify the dominant online/DTC seller in a product category and market. Respond ONLY with valid JSON, no markdown, no explanation outside the JSON.\n\n'
    + 'SUBJECT BUSINESS: ' + name + '\n'
    + 'PRODUCT CATEGORY: ' + category + '\n'
    + (city ? 'BASE LOCATION: ' + city + '\n' : '')
    + (marketReach ? 'CUSTOMER REACH (owner selected; authoritative): ' + marketReach + '\n' : '')
    + (candidateLines ? '\nCANDIDATES FROM "buy online" SEARCH:\n' + candidateLines + '\n' : '')
    + (searchExcerpt  ? '\nSEARCH RESULTS EXCERPT:\n' + searchExcerpt + '\n' : '')
    + '\nIdentify the ONE business that most clearly owns the online/e-commerce buying experience for this product in this market — the company a buyer would land on when searching "buy [product] online". '
    + 'Requirements: (1) actually sells and delivers this product type online, (2) serves the owner-selected customer reach of ' + name + ' from the same serviceable market, '
    + '(3) is NOT ' + name + ' itself, (4) is NOT a marketplace or aggregator (Amazon, eBay, Etsy, Google Shopping etc), '
    + '(5) the company must appear in the supplied search evidence. Never fill a missing answer from memory or general model knowledge. '
    + 'Return null when the evidence does not prove every requirement. '
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
    logAnthropicUsage('channel-competitor-selection', data);
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
    : arenaType === 'competitor'
    ? 'overall head-to-head purchasing decision'
    : 'brand/product arena (specialty product quality, heritage, breed specificity)';

  var arenaContext = arenaType === 'online'
    ? 'In this arena, buyers decide based on: ease of ordering online, delivery reliability, website clarity, DTC trust signals (reviews, returns policy), and online brand presence.'
    : arenaType === 'competitor'
    ? 'Compare the two businesses for the same real buyer decision in the stated category and market. Evaluate category clarity, independently verifiable trust, meaningful differentiation, and how easily an AI system can understand and recommend each company. Do not assume a product, retail, or software business model beyond the supplied category evidence.'
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
      body: JSON.stringify({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                pillars: {
                  type: 'object',
                  properties: {
                    clarity: { type: 'object', properties: { you: { type: 'number' }, competitor: { type: 'number' }, gap: { type: 'number' } }, required: ['you', 'competitor', 'gap'], additionalProperties: false },
                    trust: { type: 'object', properties: { you: { type: 'number' }, competitor: { type: 'number' }, gap: { type: 'number' } }, required: ['you', 'competitor', 'gap'], additionalProperties: false },
                    difference: { type: 'object', properties: { you: { type: 'number' }, competitor: { type: 'number' }, gap: { type: 'number' } }, required: ['you', 'competitor', 'gap'], additionalProperties: false },
                    ease: { type: 'object', properties: { you: { type: 'number' }, competitor: { type: 'number' }, gap: { type: 'number' } }, required: ['you', 'competitor', 'gap'], additionalProperties: false }
                  },
                  required: ['clarity', 'trust', 'difference', 'ease'],
                  additionalProperties: false
                },
                keyGap: { type: 'string' },
                priorityAction: { type: 'string' }
              },
              required: ['pillars', 'keyGap', 'priorityAction'],
              additionalProperties: false
            }
          }
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn('[scoreArena] Anthropic ' + res.status); return null; }
    var data = await res.json();
    logAnthropicUsage('competitor-arena-score-' + arenaType, data);
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

// Selects the closest purchasing substitute from candidates actually returned
// by the measured AI platforms. This is intentionally separate from mention
// frequency: the most repeated company is not always the closest business-model
// match (for example, a pay-TV specialist versus a subject spanning pay-TV and
// automotive).
async function selectBestFitCompetitors(evidence, candidates) {
  var name = String(evidence.name || '').trim();
  var category = String(evidence.inferredCategory || evidence.category || '').trim();
  var city = String(evidence.city || '').trim();
  var marketReach = String(evidence.marketReach || '').trim();
  var subjectType = String(evidence.subjectType || 'business').trim();
  var cleanCandidates = (candidates || []).filter(function(candidate) {
    return candidate && candidate.name;
  }).slice(0, 10);
  if (cleanCandidates.length < 2) return null;

  var prompt = 'You are adjudicating competitor candidates returned by measured AI recommendation platforms. Return only valid JSON.\n\n'
    + 'SUBJECT: ' + name + '\n'
    + 'CATEGORY: ' + category + '\n'
    + 'SUBJECT TYPE: ' + subjectType + '\n'
    + (city ? 'BASE LOCATION: ' + city + '\n' : '')
    + (marketReach ? 'CUSTOMER REACH (owner selected; authoritative): ' + marketReach + '\n' : '')
    + 'WEBSITE EVIDENCE: ' + sanitizeExternal(String(evidence.websiteText || '')).slice(0, 1600) + '\n\n'
    + 'CANDIDATES:\n'
    + cleanCandidates.map(function(candidate, index) {
      return (index + 1) + '. ' + candidate.name + ' (named by: ' + (candidate.sources || []).join(', ') + ')';
    }).join('\n')
    + '\n\nResearch each candidate on its official product and pricing pages before ranking. Rank the closest two real purchasing substitutes. Apply these tests in order:\n'
    + (subjectType === 'creator' || subjectType === 'personal_brand'
        ? '1. Same topic or expertise, overlapping audience, and comparable creator/person role or format.\n2. Same follower, viewer, collaborator, sponsor, speaker-booker, or hiring context supported by the evidence.\n3. Comparable engagement model when a paid engagement is part of the evidenced use case; do not invent one otherwise.\n'
        : subjectType === 'organization'
        ? '1. Same mission or activity and overlapping audience or beneficiaries.\n2. Same participation, support, membership, partnership, or service context supported by the evidence.\n3. Comparable operating model; do not force a commercial purchasing model onto a non-commercial organization.\n'
        : '1. Same product or service scope.\n2. Same buyer and deal tier.\n3. Same commercial model.\n')
    + '4. Same serviceable geography. Apply CUSTOMER REACH strictly: local = same city or realistic nearby catchment; regional = same region; national = available throughout the same country; international = confirmed availability across the subject\'s served countries; global = worldwide competitors are eligible. A headquarters address alone does not establish serviceability.\n'
    + '5. Same market breadth. If the subject spans multiple buyer markets, a candidate with officially confirmed coverage of those same markets outranks a specialist overlapping in only one.\n'
    + 'Tests 1 and 3 are always hard fit gates. Never claim a candidate covers a buyer market, vertical, geography, product capability, or commercial model unless an official current source explicitly supports that claim. A trend article, event appearance, device discussion, integration, OEM certification, or general cross-device statement does not prove that the candidate sells a product to that buyer market. When no candidate has confirmed coverage of every subject market, select the closest purchasing substitute and explicitly label the unmatched market as a limitation; do not upgrade partial overlap into a full match. Treat a one-time diagnostic, audit, or report purchase as a different commercial model from a recurring monitoring SaaS subscription. Treat self-service software as different from an agency or managed service.\n'
    + 'Mention frequency is only a tie-breaker after business fit. Exclude customers, suppliers, infrastructure providers, directories, and the subject itself. Choose only from the supplied candidates. In each reason, explicitly state whether product scope and commercial model are full matches or partial matches.\n\n'
    + 'Return exactly: {"best":{"name":"Candidate","reason":"one sentence"},"runnerUp":{"name":"Candidate","reason":"one sentence"}}';

  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 45000);
  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1200,
        temperature: 0,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                best: {
                  type: 'object',
                  properties: { name: { type: 'string' }, reason: { type: 'string' } },
                  required: ['name', 'reason'],
                  additionalProperties: false
                },
                runnerUp: {
                  type: 'object',
                  properties: { name: { type: 'string' }, reason: { type: 'string' } },
                  required: ['name', 'reason'],
                  additionalProperties: false
                }
              },
              required: ['best', 'runnerUp'],
              additionalProperties: false
            }
          }
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    var data = await res.json();
    logAnthropicUsage('market-competitor-adjudication', data);
    var text = (data.content || []).filter(function(block) { return block.type === 'text'; })
      .map(function(block) { return block.text || ''; }).join('').replace(/```json|```/g, '').trim();
    var start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      // Web-search models occasionally return a sourced narrative even when
      // JSON-only was requested. Normalize that completed research in a short,
      // tool-free pass instead of discarding the cross-platform adjudication.
      var normalizeController = new AbortController();
      var normalizeTimer = setTimeout(function() { normalizeController.abort(); }, 15000);
      var normalizeResponse = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: ANTHROPIC_FAST_MODEL,
          max_tokens: 500,
          temperature: 0,
          messages: [{ role: 'user', content: 'Convert the research below into the required JSON. Choose only from these candidates: '
            + cleanCandidates.map(function(candidate) { return candidate.name; }).join(', ')
            + '\nReturn exactly {"best":{"name":"Candidate","reason":"one sentence"},"runnerUp":{"name":"Candidate","reason":"one sentence"}}.\n\nRESEARCH:\n'
            + text.slice(0, 5000) }],
          output_config: {
            format: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: {
                  best: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name', 'reason'], additionalProperties: false },
                  runnerUp: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name', 'reason'], additionalProperties: false }
                },
                required: ['best', 'runnerUp'],
                additionalProperties: false
              }
            }
          }
        }),
        signal: normalizeController.signal
      });
      clearTimeout(normalizeTimer);
      if (!normalizeResponse.ok) throw parseError;
      var normalizeData = await normalizeResponse.json();
      logAnthropicUsage('market-competitor-json-normalization', normalizeData);
      var normalizeText = (normalizeData.content || []).filter(function(block) { return block.type === 'text'; })
        .map(function(block) { return block.text || ''; }).join('').replace(/```json|```/g, '').trim();
      var normalizeStart = normalizeText.indexOf('{'), normalizeEnd = normalizeText.lastIndexOf('}');
      if (normalizeStart >= 0 && normalizeEnd > normalizeStart) normalizeText = normalizeText.slice(normalizeStart, normalizeEnd + 1);
      parsed = JSON.parse(normalizeText);
    }
    var allowed = {};
    cleanCandidates.forEach(function(candidate) {
      allowed[String(candidate.name).toLowerCase().replace(/[^a-z0-9]/g, '')] = candidate;
    });
    function validated(value) {
      var candidateName = String(value && value.name || '').trim();
      var match = allowed[candidateName.toLowerCase().replace(/[^a-z0-9]/g, '')];
      if (!match) return null;
      var fullReason = String(value.reason || '').trim();
      if (fullReason.length > 800) {
        var reasonCut = fullReason.lastIndexOf('.', 800);
        fullReason = reasonCut > 250 ? fullReason.slice(0, reasonCut + 1) : fullReason.slice(0, 800);
      }
      return {
        name: match.name,
        sources: match.sources || [],
        reason: fullReason
      };
    }
    var best = validated(parsed.best);
    var runnerUp = validated(parsed.runnerUp);
    if (!best) return null;
    if (runnerUp && runnerUp.name === best.name) runnerUp = null;
    return { best: best, runnerUp: runnerUp };
  } catch (err) {
    clearTimeout(timer);
    console.warn('[best-fit-competitors] failed:', err.message);
    return null;
  }
}

module.exports = { scoreWithClaude, inferCategory, selectChannelCompetitor, scoreArena, selectBestFitCompetitors };
