'use strict';

// Scores one verified competitor with the same evidence collection and
// deterministic four-pillar rubric used for the diagnosed business.
//
// This module does not select competitors. The caller must first confirm that
// the company serves the same buyer and need. Missing evidence is returned as
// "score_unavailable" or "not_measured"; it is never changed into zero.

const { searchSerper, inferOfficialSite } = require('./serper');
const { fetchWebsiteText, fetchReviewPages, buildReviewText } = require('./fetchWebsite');
const { fetchSocialEvidence, buildSocialText } = require('./social');
const { fetchApifyEvidence } = require('./apify');
const { scoreWithClaude } = require('./claude');
const { hasValidShape, buildSafeOutput } = require('./validators');
const { applyDeterministicScoring } = require('./deterministic-scoring');

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
    scoreMethod: null,
    priorityAction: ''
  };
}

function pillarMeasurement(pillar) {
  var measurement = pillar && pillar.measurement && typeof pillar.measurement === 'object'
    ? pillar.measurement
    : {};
  var measured = numberOrNull(measurement.measuredPoints);
  var total = numberOrNull(measurement.totalPoints);
  var enoughEvidence = measured !== null && total !== null && total > 0 && measured / total >= 0.5;
  return {
    measuredPoints: measured,
    totalPoints: total,
    enoughEvidence: enoughEvidence,
    complete: measurement.complete === true,
    unavailableChecks: Array.isArray(measurement.unavailableChecks)
      ? measurement.unavailableChecks
      : []
  };
}

function buildPillarComparison(scored, subjectResult) {
  var comparison = {};
  PILLARS.forEach(function(key) {
    var competitorPillar = scored && scored.pillars && scored.pillars[key] || {};
    var subjectPillar = subjectResult && subjectResult.pillars && subjectResult.pillars[key] || {};
    var measurement = pillarMeasurement(competitorPillar);
    var competitorScore = measurement.enoughEvidence ? numberOrNull(competitorPillar.score) : null;
    var subjectScore = numberOrNull(subjectPillar.score);

    comparison[key] = {
      business: subjectScore,
      competitor: competitorScore,
      gap: subjectScore !== null && competitorScore !== null
        ? round(subjectScore - competitorScore)
        : null,
      status: competitorScore === null ? 'not_measured' : 'measured',
      finding: competitorScore === null
        ? 'Not measured. CHOIVE did not collect enough evidence for this pillar.'
        : text(competitorPillar.finding),
      measurement: measurement,
      confidence: competitorPillar.confidence || null
    };
  });
  return comparison;
}

async function scoreCompetitor(candidate, context, subjectResult) {
  candidate = candidate && typeof candidate === 'object' ? candidate : {};
  context = context && typeof context === 'object' ? context : {};

  var name = text(candidate.name);
  var role = text(candidate.role) || 'competitor';
  if (!name) return unavailable(candidate, role, 'Competitor name is missing.', '');

  // Verification must be explicit. This scorer must not turn an AI answer or
  // an unreviewed search result into a verified competitor.
  if (candidate.verified !== true) {
    return unavailable(candidate, role, 'CHOIVE did not verify that this company serves the same buyer and need.', '');
  }

  var category = text(context.category || context.inferredCategory);
  var city = text(context.city);
  if (!category) {
    return unavailable(candidate, role, 'The category needed to score this competitor is missing.', '');
  }

  var searchPayload;
  try {
    searchPayload = await searchSerper(name, category, city);
  } catch (error) {
    return unavailable(candidate, role, 'Competitor search failed. No score was created.', '');
  }

  var suppliedWebsite = asUrl(candidate.website || candidate.domain);
  var officialWebsite = suppliedWebsite || asUrl(inferOfficialSite('', searchPayload, name));
  if (!officialWebsite) {
    return unavailable(candidate, role, 'CHOIVE could not verify the competitor’s official website.', '');
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
    return unavailable(candidate, role, 'The competitor’s website could not be read. Its score was not measured.', officialWebsite);
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
  var apifyResult = extraEvidence[2].status === 'fulfilled'
    ? extraEvidence[2].value || {}
    : {};
  var reviewMeasurement = apifyResult.measurement || {
    trustpilot: 'unavailable',
    googleReviews: 'unavailable'
  };

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
    inferredOfficialSite: officialWebsite,
    subjectType: text(context.subjectType) || 'business',
    marketReach: text(context.marketReach),
    description: text(candidate.description),
    websiteText: websiteText,
    websiteSignals: websiteSignals,
    searchText: searchPayload.searchText || 'No search results returned.',
    searchResults: searchPayload.results || [],
    searchMeasurement: searchPayload.measurement || {
      status: 'unavailable', totalQueries: 0, completedQueries: 0, failedQueries: 0
    },
    knowledgeGraph: searchPayload.knowledgeGraph || null,
    kgText: searchPayload.kgText || 'None',
    competitors: searchPayload.competitors || [],
    socialSignals: searchPayload.socialSignals || {},
    socialEvidence: socialEvidence,
    socialText: buildSocialText(socialEvidence),
    summaries: searchPayload.summaries || {},
    reviewPages: reviewPages,
    reviewText: buildReviewText(reviewPages),
    reviewMeasurement: reviewMeasurement,
    apifyText: apifyResult.apifyText || '',
    trustpilot: apifyResult.trustpilot || null,
    googleReviews: apifyResult.googleReviews || null,
    collectedAt: new Date().toISOString()
  };

  var modelResult;
  try {
    modelResult = await scoreWithClaude(evidence);
  } catch (error) {
    return unavailable(candidate, role, 'The competitor analysis failed. No score was created.', officialWebsite);
  }
  if (!hasValidShape(modelResult)) {
    return unavailable(candidate, role, 'The competitor analysis was incomplete. No score was created.', officialWebsite);
  }

  var scored = applyDeterministicScoring(evidence, buildSafeOutput(modelResult));
  var pillars = buildPillarComparison(scored, subjectResult || {});
  var measuredScores = PILLARS.map(function(key) { return pillars[key].competitor; })
    .filter(function(value) { return value !== null; });
  var completeScore = measuredScores.length === PILLARS.length;

  return {
    name: name,
    role: role,
    roleLabel: text(candidate.roleLabel) || role,
    website: officialWebsite,
    status: completeScore ? 'measured' : 'partially_measured',
    reason: completeScore
      ? 'Scored from the competitor’s own recorded evidence.'
      : 'Some pillars are not measured because CHOIVE did not collect enough evidence.',
    score: completeScore ? round(measuredScores.reduce(function(total, value) { return total + value; }, 0)) : null,
    pillars: pillars,
    scoreMethod: scored.scoreMethod || null,
    priorityAction: scored.actions && scored.actions[0]
      ? text(scored.actions[0].title || scored.actions[0].body)
      : ''
  };
}

module.exports = {
  scoreCompetitor: scoreCompetitor
};
