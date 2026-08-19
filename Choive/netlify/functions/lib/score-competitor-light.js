'use strict';

// Lightweight competitor scoring for comparison charts.
// Uses same evidence collection as main scoring but a much faster Claude call
// that returns only pillar scores + brief findings (no narratives, actions, or assets).
// Output: ~500-800 tokens vs ~6,800 in full scoring.

const { searchSerper, inferOfficialSite } = require('./serper');
const { fetchWebsiteText, fetchReviewPages, buildReviewText } = require('./fetchWebsite');
const { fetchSocialEvidence, buildSocialText } = require('./social');
const { fetchApifyEvidence } = require('./apify');
const { logAnthropicUsage } = require('./anthropic-usage');

const PILLARS = ['clarity', 'trust', 'difference', 'ease'];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrNull(value) {
  var number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Math.round(Number(value) * 10) / 10;
}

function asUrl(value) {
  var url = text(value);
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

function meaningfulNameTokens(name) {
  return text(name)
    .toLowerCase()
    .replace(/\b(gmbh|ug|ag|kg|inc|llc|ltd|limited|corp|corporation|plc|bv|sarl|sas|srl)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(function(token) { return token.length >= 3; });
}

function websiteMatchesName(name, signals, websiteText) {
  var tokens = meaningfulNameTokens(name);
  if (!tokens.length) return false;
  var pageIdentity = [
    signals && signals.titleText,
    signals && signals.h1Text,
    String(websiteText || '').slice(0, 1200)
  ].join(' ').toLowerCase();
  return tokens.some(function(token) { return pageIdentity.indexOf(token) !== -1; });
}

function unavailable(candidate, role, reason, website) {
  return {
    name: text(candidate && candidate.name),
    role: role,
    roleLabel: text(candidate && candidate.roleLabel) || role,
    website: website || null,
    status: 'score_unavailable',
    reason: reason,
    score: null,
    pillars: null,
    scoreMethod: 'lightweight',
    priorityAction: ''
  };
}

function sanitizeExternal(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function truncate(value, maxLength) {
  var str = String(value || '');
  return str.length > maxLength ? str.slice(0, maxLength) + '...' : str;
}

function buildLightPrompt(evidence) {
  var name = evidence.name || '';
  var category = evidence.category || '';
  var city = evidence.city || '';
  var subjectType = evidence.subjectType || 'business';
  var websiteText = sanitizeExternal(truncate(evidence.websiteText, 2000)) || 'No website content available.';
  var searchText = sanitizeExternal(truncate(evidence.searchText || '', 3000)) || 'No search results returned.';
  var kgText = sanitizeExternal(truncate(evidence.kgText, 800)) || 'None';
  var reviewText = sanitizeExternal(evidence.reviewText || 'No review platform pages found.');
  var socialText = sanitizeExternal(evidence.socialText || 'No social media pages found.');
  
  var websiteSignals = evidence.websiteSignals || {};
  var signalsText = '';
  if (websiteSignals.h1Text) signalsText += 'H1: ' + websiteSignals.h1Text + '\n';
  if (websiteSignals.metaDescription) signalsText += 'Meta description: present\n';
  if (websiteSignals.schema) signalsText += 'Schema: ' + websiteSignals.schema + '\n';
  if (websiteSignals.llmstxt) signalsText += 'llms.txt: present\n';
  if (websiteSignals.googleRating) signalsText += 'Google reviews: ' + websiteSignals.googleRating + ' (' + (websiteSignals.googleReviewCount || 0) + ' reviews)\n';
  if (websiteSignals.trustpilotRating) signalsText += 'Trustpilot: ' + websiteSignals.trustpilotRating + ' (' + (websiteSignals.trustpilotReviewCount || 0) + ' reviews)\n';
  
  var subjectRule = subjectType === 'creator'
    ? 'CREATOR: Clarity=clear topic/audience, Trust=verified coverage/collaborations, Difference=distinct POV/expertise, Ease=findable across channels'
    : subjectType === 'organization'
      ? 'ORGANIZATION: Clarity=clear mission/scope, Trust=registrations/partners/coverage, Difference=distinct mission/method, Ease=easy to verify/contact'
      : 'BUSINESS: Clarity=precise offer/buyer/market, Trust=reviews/clients/credentials, Difference=evidenced advantage, Ease=buyer can find/verify/purchase';
  
  var prompt = 'Score this competitor on the CHOIVE 4-pillar rubric (Clarity, Trust, Difference, Ease).\n\n'
    + 'COMPETITOR:\n'
    + 'Name: ' + name + '\n'
    + 'Category: ' + category + '\n'
    + 'Location: ' + city + '\n'
    + 'Type: ' + subjectType + '\n\n'
    + 'SCORING RULE: ' + subjectRule + '\n\n'
    + 'CONFIRMED SIGNALS:\n' + (signalsText || 'None detected\n') + '\n'
    + 'KNOWLEDGE GRAPH:\n' + kgText + '\n\n'
    + 'WEBSITE CONTENT:\n' + websiteText + '\n\n'
    + 'SEARCH RESULTS:\n' + searchText + '\n\n'
    + 'SOCIAL MEDIA:\n' + socialText + '\n\n'
    + 'REVIEWS:\n' + reviewText + '\n\n'
    + 'INSTRUCTIONS:\n'
    + '- Score each pillar 0-25 based on evidence strength\n'
    + '- finding: one short sentence (max 12 words) stating the key gap or strength for this pillar\n'
    + '- evidence: cite the specific signal, text, or absence that determined the score\n'
    + '- Keep each evidence field under 100 characters\n'
    + '- Missing evidence scores low; do not invent facts\n'
    + '- Write for a business owner, not technical audience\n\n'
    + 'Respond with ONLY this JSON (no markdown, no extra text):\n\n'
    + '{\n'
    + '  "clarity": { "score": 0, "finding": "", "evidence": "" },\n'
    + '  "trust": { "score": 0, "finding": "", "evidence": "" },\n'
    + '  "difference": { "score": 0, "finding": "", "evidence": "" },\n'
    + '  "ease": { "score": 0, "finding": "", "evidence": "" }\n'
    + '}';
  
  return prompt;
}

async function scoreCompetitorLight(candidate, context, subjectResult) {
  candidate = candidate && typeof candidate === 'object' ? candidate : {};
  context = context && typeof context === 'object' ? context : {};

  var name = text(candidate.name);
  var role = text(candidate.role) || 'competitor';
  if (!name) return unavailable(candidate, role, 'Competitor name is missing.', '');

  if (candidate.verified !== true) {
    return unavailable(candidate, role, 'CHOIVE did not verify that this company serves the same buyer and need.', '');
  }

  var category = text(context.category || context.inferredCategory);
  var city = text(context.city);
  if (!category) {
    return unavailable(candidate, role, 'The category needed to score this competitor is missing.', '');
  }

  // Same evidence gathering as full scoring (needs to be accurate)
  var searchPayload;
  try {
    searchPayload = await searchSerper(name, category, city);
  } catch (error) {
    return unavailable(candidate, role, 'Competitor search failed. No score was created.', '');
  }

  var suppliedWebsite = asUrl(candidate.website || candidate.domain);
  var officialWebsite = suppliedWebsite || asUrl(inferOfficialSite('', searchPayload, name));
  if (!officialWebsite) {
    return unavailable(candidate, role, 'CHOIVE could not verify the competitor\'s official website.', '');
  }

  var websiteResult;
  try {
    websiteResult = await fetchWebsiteText(officialWebsite);
  } catch (error) {
    websiteResult = { text: '', signals: { fetchSucceeded: false, fetchFailed: true } };
  }

  var websiteText = text(websiteResult && websiteResult.text);
  var websiteSignals = websiteResult && websiteResult.signals || {};
  if (!websiteText || websiteSignals.fetchFailed === true) {
    return unavailable(candidate, role, 'The competitor\'s website could not be read. Its score was not measured.', officialWebsite);
  }
  if (!websiteMatchesName(name, websiteSignals, websiteText)) {
    return unavailable(candidate, role, 'The website found does not clearly belong to this competitor.', officialWebsite);
  }

  var extraEvidence = await Promise.allSettled([
    fetchReviewPages(searchPayload.results || []),
    fetchSocialEvidence(searchPayload.results || [], name),
    fetchApifyEvidence(name, city, officialWebsite)
  ]);

  var reviewPages = extraEvidence[0].status === 'fulfilled' ? extraEvidence[0].value || {} : {};
  var socialEvidence = extraEvidence[1].status === 'fulfilled' ? extraEvidence[1].value || {} : {};
  var apifyResult = extraEvidence[2].status === 'fulfilled' ? extraEvidence[2].value || {} : {};

  var confirmedReviewPlatforms = Object.keys(reviewPages);
  if (confirmedReviewPlatforms.length) {
    websiteSignals.confirmedReviewPlatforms = confirmedReviewPlatforms;
  }
  if (apifyResult.trustpilot) {
    websiteSignals.trustpilotRating = apifyResult.trustpilot.rating || null;
    websiteSignals.trustpilotReviewCount = apifyResult.trustpilot.reviewCount || 0;
  }
  if (apifyResult.googleReviews) {
    websiteSignals.googleRating = apifyResult.googleReviews.rating || null;
    websiteSignals.googleReviewCount = apifyResult.googleReviews.reviewCount || 0;
  }

  var evidence = {
    name: name,
    category: category,
    inferredCategory: category,
    city: city,
    website: officialWebsite,
    subjectType: text(context.subjectType) || 'business',
    marketReach: text(context.marketReach),
    websiteText: websiteText,
    websiteSignals: websiteSignals,
    searchText: searchPayload.searchText || 'No search results returned.',
    kgText: searchPayload.kgText || 'None',
    socialText: buildSocialText(socialEvidence),
    reviewText: buildReviewText(reviewPages)
  };

  // Lightweight Claude call — much smaller prompt and output
  var modelResult;
  try {
    var prompt = buildLightPrompt(evidence);
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 45000); // 45s timeout vs 240s for full scoring
    
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1500, // Much smaller than the 16000 used for full scoring
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    
    clearTimeout(timer);
    
    if (!response.ok) {
      var errBody = '';
      try { var errJson = await response.json(); errBody = (errJson && errJson.error && errJson.error.message) ? errJson.error.message : ''; } catch (e) {}
      throw new Error(errBody || 'Anthropic HTTP ' + response.status);
    }
    
    var data = await response.json();
    logAnthropicUsage('competitor-light-scoring', data);
    
    var raw = (data.content || []).filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text || ''; }).join('').trim();
    var cleaned = raw.replace(/```json|```/g, '').trim();
    modelResult = JSON.parse(cleaned);
  } catch (error) {
    console.warn('[score-competitor-light] Scoring failed for ' + name + ':', error.message);
    return unavailable(candidate, role, 'The competitor analysis failed. No score was created.', officialWebsite);
  }

  // Validate output shape
  if (!modelResult || typeof modelResult !== 'object') {
    return unavailable(candidate, role, 'The competitor analysis was incomplete. No score was created.', officialWebsite);
  }

  var validPillars = PILLARS.every(function(key) {
    var pillar = modelResult[key];
    return pillar && typeof pillar === 'object'
      && typeof pillar.score === 'number'
      && typeof pillar.finding === 'string'
      && typeof pillar.evidence === 'string';
  });

  if (!validPillars) {
    return unavailable(candidate, role, 'The competitor analysis was incomplete. No score was created.', officialWebsite);
  }

  // Build comparison with subject's pillars
  var pillars = {};
  var measuredScores = [];
  var keyGap = '';
  var largestDeficit = 0;
  
  PILLARS.forEach(function(key) {
    var competitorPillar = modelResult[key];
    var subjectPillar = subjectResult && subjectResult.pillars && subjectResult.pillars[key] || {};
    
    var competitorScore = round(Math.max(0, Math.min(25, numberOrNull(competitorPillar.score) || 0)));
    var subjectScore = numberOrNull(subjectPillar.score);
    
    measuredScores.push(competitorScore);
    
    var gap = subjectScore !== null ? round(subjectScore - competitorScore) : null;
    if (gap !== null && gap < largestDeficit) {
      largestDeficit = gap;
      keyGap = key;
    }
    
    pillars[key] = {
      you: subjectScore,
      business: subjectScore,
      competitor: competitorScore,
      gap: gap,
      status: 'measured',
      finding: text(competitorPillar.finding),
      evidence: text(competitorPillar.evidence),
      measurement: {
        measuredPoints: competitorScore,
        totalPoints: 25,
        enoughEvidence: true,
        complete: true,
        unavailableChecks: []
      },
      confidence: null
    };
  });

  var totalScore = round(measuredScores.reduce(function(sum, val) { return sum + val; }, 0));

  return {
    name: name,
    role: role,
    roleLabel: text(candidate.roleLabel) || role,
    website: officialWebsite,
    status: 'complete',
    reason: 'Scored from the competitor\'s own recorded evidence.',
    score: totalScore,
    competitorOverallScore: totalScore,
    keyGap: keyGap,
    pillars: pillars,
    scoreMethod: 'lightweight',
    priorityAction: ''
  };
}

module.exports = {
  scoreCompetitorLight: scoreCompetitorLight
};
