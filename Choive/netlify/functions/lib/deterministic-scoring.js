// CHOIVE point allocation from recorded evidence.
//
// Code, not model-proposed numbers, allocates every point. Some inputs are
// mechanically observed and some are explicitly labelled model_assessed. The
// ledger keeps that distinction visible instead of presenting interpretation
// as mechanical fact.

'use strict';

const { RUBRIC_VERSION, measurementProvenance } = require('./measurement-standard');

function safeArray(value) { return Array.isArray(value) ? value : []; }
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clamp(value, max) { return Math.max(0, Math.min(max, Number(value) || 0)); }

var NON_INDEPENDENT_HOSTS = [
  'linkedin.com', 'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com',
  'x.com', 'twitter.com', 'pinterest.com', 'crunchbase.com', 'handelsregister.ai',
  'northdata.com', 'companieshouse.gov.uk', 'companyhouse.de'
];

function hostMatches(host, blocked) {
  return host === blocked || host.endsWith('.' + blocked);
}

var LEGAL_SUFFIX_RE = /\b(gmbh|ug|ag|kg|ohg|mbh|e\.?v|inc|llc|ltd|limited|corp|corporation|co|plc|bv|b\.?v|nv|n\.?v|sarl|sas|sa|srl|spa|ab|as|oy|aps|pty|pte|kft|zrt|sp\s*z\s*o\s*o|s\.?r\.?o)\b\.?/gi;

// A search result names the subject when every meaningful token of the
// business name appears in the title or snippet. The previous raw-substring
// test required the full submitted string verbatim, so "Taurbull GmbH" never
// matched a press headline reading "Taurbull raises..." — costing the business
// every independent trust point purely because it typed its legal form.
function textNamesSubject(text, name) {
  var haystack = String(text || '').toLowerCase();
  var core = String(name || '').toLowerCase().replace(LEGAL_SUFFIX_RE, ' ');
  var tokens = core.replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(function (token) {
    return token.length >= 2;
  });
  if (!tokens.length) return true;
  return tokens.every(function (token) { return haystack.indexOf(token) !== -1; });
}

// True when a provider or fetch did not produce a usable measurement, as
// opposed to producing a measurement whose value is zero. The two must never
// score the same way: an expired API key is not evidence that a business has
// no press coverage.
function isUnavailable(state) {
  return state === 'unavailable' || state === 'not_measured' || state === 'failed' || state === 'error';
}

function siteUrl(evidence, suffix) {
  var raw = String(evidence.website || evidence.inferredOfficialSite || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try { return new URL(suffix || '/', raw).href; } catch (_) { return raw; }
}

function entry(ruleId, label, points, maxPoints, observed, source, verification) {
  return {
    ruleId: ruleId,
    label: label,
    points: Math.round(clamp(points, maxPoints) * 10) / 10,
    maxPoints: maxPoints,
    observed: String(observed || 'Not established'),
    source: source || '',
    verification: verification
  };
}

// Converting a partially measured pillar to the 25-point scale assumes the
// unmeasured checks would have scored at the same rate as the measured ones.
// That assumption is only defensible while most of the pillar was actually
// measured. Below this coverage the earned points are reported as they stand.
var MIN_EXTRAPOLATION_COVERAGE = 0.5;

function score(entries) {
  var measured = entries.filter(function(item) { return item.verification !== 'unmeasured'; });
  var earned = measured.reduce(function(total, item) { return total + item.points; }, 0);
  var measuredMaximum = measured.reduce(function(total, item) { return total + item.maxPoints; }, 0);
  var fullMaximum = entries.reduce(function(total, item) { return total + item.maxPoints; }, 0);
  if (!measuredMaximum || !fullMaximum) return 0;
  // Guard against inflation from a thin measured base. Without this, a pillar
  // with 2 of 25 points measured and both earned reports 25/25 — a perfect
  // score derived from 8% of the rubric.
  if (measuredMaximum / fullMaximum < MIN_EXTRAPOLATION_COVERAGE) {
    return Math.round(earned * 10) / 10;
  }
  var extrapolated = earned / measuredMaximum * fullMaximum;
  // Full marks require a complete rubric. A pillar with an unmeasured check has
  // not demonstrated the points it is being credited for.
  if (measured.length !== entries.length) {
    extrapolated = Math.min(extrapolated, fullMaximum - 1);
  }
  return Math.round(extrapolated * 10) / 10;
}

function confidence(entries) {
  var measured = entries.filter(function(item) { return item.verification !== 'unmeasured'; });
  var possible = measured.reduce(function(total, item) { return total + item.maxPoints; }, 0);
  var verified = measured.reduce(function(total, item) {
    return total + (item.verification === 'mechanical' || item.verification === 'independent' ? item.maxPoints : 0);
  }, 0);
  var ratio = possible ? verified / possible : 0;
  return {
    level: ratio >= 0.8 ? 'high' : ratio >= 0.5 ? 'medium' : 'low',
    score: Math.round(ratio * 100),
    basis: 'Percentage of this rubric verified mechanically or through independently retrieved sources.'
  };
}

function measurementCoverage(entries) {
  var available = entries.filter(function(item) { return item.verification !== 'unmeasured'; });
  var unavailable = entries.filter(function(item) { return item.verification === 'unmeasured'; });
  return {
    earnedMeasuredPoints: Math.round(available.reduce(function(total, item) { return total + item.points; }, 0) * 10) / 10,
    measuredPoints: available.reduce(function(total, item) { return total + item.maxPoints; }, 0),
    totalPoints: entries.reduce(function(total, item) { return total + item.maxPoints; }, 0),
    unavailableChecks: unavailable.map(function(item) { return item.label; }),
    complete: unavailable.length === 0,
    explanation: unavailable.length
      ? 'Unavailable checks were excluded from the score denominator because an unavailable check is not proof that the signal is absent. The measured result was converted to the standard 25-point pillar scale.'
      : 'All scoring checks for this pillar completed.'
  };
}

function auditItem(result, pillar, prefix) {
  var list = safeArray(safeObject(result.signalAudit)[pillar]);
  var wanted = String(prefix || '').toLowerCase();
  return safeObject(list.find(function(item) {
    return String(item && item.name || '').toLowerCase().indexOf(wanted) === 0;
  }));
}

function auditPoints(item, maxPoints) {
  var status = String(item.status || '').toLowerCase();
  if (status === 'pass') return maxPoints;
  if (status === 'partial') return Math.round(maxPoints / 2 * 10) / 10;
  return 0;
}

function auditEntry(ruleId, label, maxPoints, result, pillar, prefix, source) {
  var item = auditItem(result, pillar, prefix);
  return entry(
    ruleId,
    label,
    auditPoints(item, maxPoints),
    maxPoints,
    item.detail || 'No supported evidence returned',
    source,
    'model_assessed'
  );
}

function namedClientPartnerEntry(evidence, result) {
  var root = siteUrl(evidence, '/');
  var item = auditItem(result, 'difference', 'Named client or partner');
  var detail = String(item.detail || 'No supported evidence returned');
  var roleOnly = /\b(agent|employee|founder|team member|staff|director|broker)\b/i.test(detail)
    && !/\b(named client|client named|customer named|named customer|partner named|named partner)\b/i.test(detail);
  return entry(
    'DI-02',
    'Named client or partner',
    roleOnly ? 0 : auditPoints(item, 6),
    6,
    roleOnly ? 'A staff or agent name is not evidence of a named client or partner' : detail,
    root,
    'model_assessed'
  );
}

function independentResults(evidence, signalType) {
  var official = '';
  try { official = new URL(siteUrl(evidence, '/')).hostname.replace(/^www\./, ''); } catch (_) {}
  var name = String(evidence.name || '').toLowerCase();
  return safeArray(evidence.searchResults).filter(function(item) {
    if (!item || item.signalType !== signalType || !item.link) return false;
    var host = '';
    try { host = new URL(item.link).hostname.replace(/^www\./, ''); } catch (_) {}
    var sameOfficialSite = official && (host === official
      || host.endsWith('.' + official)
      || official.endsWith('.' + host));
    var nonIndependent = NON_INDEPENDENT_HOSTS.some(function(blocked) {
      return hostMatches(host, blocked);
    });
    if (!host || sameOfficialSite || nonIndependent) return false;
    var text = String(item.title || '') + ' ' + String(item.snippet || '');
    return textNamesSubject(text, name);
  });
}

// The search leg is unavailable when the provider reported a failure, or when
// it returned nothing at all while reporting no completed queries. An empty
// result set from a completed search is a real finding; an empty result set
// from a search that never ran is not.
function searchUnavailable(evidence) {
  var measurement = safeObject(evidence.searchMeasurement);
  if (isUnavailable(measurement.status)) return true;
  if (Number(measurement.completedQueries) > 0) return false;
  if (Number(measurement.failedQueries) > 0) return true;
  // No measurement metadata at all (older records) — fall back to the previous
  // behaviour and treat the result set as genuine.
  return false;
}

function reviewEvidence(evidence) {
  var signals = safeObject(evidence.websiteSignals);
  var platforms = safeArray(signals.confirmedReviewPlatforms).filter(Boolean);
  var trustpilot = safeObject(evidence.trustpilot);
  var google = safeObject(evidence.googleReviews);
  var count = Math.max(
    Number(signals.trustpilotReviewCount) || 0,
    Number(signals.googleReviewCount) || 0,
    Number(trustpilot.reviewCount) || 0,
    Number(google.reviewCount) || 0
  );
  var verified = platforms.length > 0
    || Boolean(trustpilot.platform && (trustpilot.rating || trustpilot.reviewCount || trustpilot.url))
    || Boolean(google.platform && (google.rating || google.reviewCount || google.url));
  var source = trustpilot.url || google.url || (platforms.length ? platforms.join(', ') : '');
  var measurement = safeObject(evidence.reviewMeasurement);
  // A review provider that was never configured, never ran, or rejected is
  // unavailable — not a business without reviews. The previous test matched
  // only the literal string 'unavailable', so an unset APIFY_API_KEY
  // ('not_measured') and a rejected Apify leg (no reviewMeasurement recorded
  // at all) were both scored as a confirmed absence of reviews.
  var noMeasurementRecorded = !measurement.trustpilot && !measurement.googleReviews;
  var unavailable = !verified
    && (isUnavailable(measurement.trustpilot) || isUnavailable(measurement.googleReviews) || noMeasurementRecorded);
  return { verified: verified, count: count, platforms: platforms, source: source, unavailable: unavailable };
}

// True when the website fetch produced no observation at all. Every mechanical
// clarity/ease check reads from websiteSignals, and an unreachable site
// produces exactly the same all-false signal set as a reachable site with no
// title, no H1 and no schema. Scoring those identically converts a WAF block or
// an 8s timeout into ~32 points of confirmed absence.
function websiteUnavailable(evidence) {
  var s = safeObject(evidence.websiteSignals);
  if (s.fetchFailed === true) return true;
  if (s.fetchSucceeded === false) return true;
  return false;
}

// Mechanical entry that degrades to 'unmeasured' when the underlying fetch
// never returned, so the point drops out of the denominator instead of being
// scored as a verified zero.
function mechanicalEntry(unavailable, ruleId, label, points, maxPoints, observed, source) {
  return entry(ruleId, label, unavailable ? 0 : points, maxPoints,
    unavailable ? 'Not measured — the website could not be retrieved in this run' : observed,
    source, unavailable ? 'unmeasured' : 'mechanical');
}

function isEnterpriseSubject(evidence) {
  var text = [evidence.category, evidence.description, evidence.subjectType].join(' ').toLowerCase();
  return /\bb2b\b|enterprise|middleware|saas|software platform|pay-tv|telecom|operator|oem|procurement/.test(text);
}

function scaledReviewPoints(count, maxPoints) {
  if (count >= 100) return maxPoints;
  if (count >= 25) return maxPoints * 0.8;
  if (count >= 5) return maxPoints * 0.55;
  if (count >= 1) return maxPoints * 0.25;
  return 0;
}

function clarityEntries(evidence, result) {
  var s = safeObject(evidence.websiteSignals);
  var root = siteUrl(evidence, '/');
  var siteDown = websiteUnavailable(evidence);
  return [
    mechanicalEntry(siteDown, 'CL-01', 'Page title present', s.hasTitle ? 3 : 0, 3, s.titleText || 'Not detected', root),
    mechanicalEntry(siteDown, 'CL-02', 'Primary H1 present', s.hasH1 ? 3 : 0, 3, s.h1Text || 'Not detected', root),
    mechanicalEntry(siteDown, 'CL-03', 'Meta description present', s.hasMetaDescription ? 3 : 0, 3, s.metaDescriptionText || 'Not detected', root),
    auditEntry('CL-04', 'H1 names the product or service', 6, result, 'clarity', 'H1 headline', root),
    auditEntry('CL-05', 'Homepage explains what the subject does', 6, result, 'clarity', 'Homepage category', root),
    auditEntry('CL-06', 'Name is consistent across sources', 4, result, 'clarity', 'Business name consistent', independentResults(evidence, 'identity').map(function(item) { return item.link; }))
  ];
}

function trustEntries(evidence) {
  var reviews = reviewEvidence(evidence);
  var enterprise = isEnterpriseSubject(evidence);
  var reviewIdentityMax = enterprise ? 2 : 4;
  var reviewVolumeMax = enterprise ? 2 : 4;
  var authorityMax = enterprise ? 10 : 8;
  var reputationMax = enterprise ? 4 : 5;
  var proofMax = enterprise ? 7 : 4;
  var searchDown = searchUnavailable(evidence);
  var siteDown = websiteUnavailable(evidence);
  var authority = independentResults(evidence, 'authority').slice(0, 4);
  var reputation = independentResults(evidence, 'reputation').slice(0, 3);
  var proofMatch = String(evidence.websiteText || '').match(/PUBLIC PROOF PAGE CONTENT:\s*([\s\S]+)/i);
  var proofLength = proofMatch ? String(proofMatch[1] || '').trim().length : 0;
  return [
    entry('TR-01', 'Verified external review record', reviews.verified ? reviewIdentityMax : 0, reviewIdentityMax, reviews.verified ? (reviews.platforms.join(', ') || 'Verified review record') : (reviews.unavailable ? 'Not verified — review provider unavailable during this run' : 'No verified review record found'), reviews.source, reviews.unavailable ? 'unmeasured' : 'independent'),
    entry('TR-02', 'Verified review volume', scaledReviewPoints(reviews.count, reviewVolumeMax), reviewVolumeMax, reviews.verified ? (reviews.count + ' verified reviews') : (reviews.unavailable ? 'Review count not verified — provider unavailable' : 'No verified review count found'), reviews.source, reviews.unavailable ? 'unmeasured' : 'independent'),
    entry('TR-03', 'Independent authority coverage', searchDown ? 0 : Math.min(authorityMax, authority.length * (authorityMax / 4)), authorityMax, searchDown ? 'Not measured — the independent search provider did not return results in this run' : (authority.length + ' relevant independent result(s)'), authority.map(function(item) { return item.link; }), searchDown ? 'unmeasured' : 'independent'),
    entry('TR-04', 'Independent reputation evidence', searchDown ? 0 : Math.min(reputationMax, reputation.length * (reputationMax / 3)), reputationMax, searchDown ? 'Not measured — the independent search provider did not return results in this run' : (reputation.length + ' relevant independent result(s)'), reputation.map(function(item) { return item.link; }), searchDown ? 'unmeasured' : 'independent'),
    mechanicalEntry(siteDown, 'TR-05', 'Substantive proof on owned pages', proofLength >= 120 ? proofMax : 0, proofMax, proofLength ? proofLength + ' proof-page characters collected' : 'Not detected', siteUrl(evidence, '/case-studies'))
  ];
}

function differenceEntries(evidence, result) {
  var root = siteUrl(evidence, '/');
  return [
    auditEntry('DI-01', 'Specific differentiator stated', 7, result, 'difference', 'Named differentiator', root),
    namedClientPartnerEntry(evidence, result),
    auditEntry('DI-03', 'Defined niche or category position', 6, result, 'difference', 'Niche or category', root),
    auditEntry('DI-04', 'Measurable outcome proof', 6, result, 'difference', 'Proof of outcome', root)
  ];
}

function auditEvidenceText(entries) {
  return entries.map(function(item) {
    return item.label + ': ' + item.observed;
  }).join('. ') + '.';
}

function reconcileNarrativeWithLedger(result, audits) {
  var trust = result.pillars.trust;
  var trustUnavailable = audits.trust.filter(function(item) { return item.verification === 'unmeasured'; });
  var trustPositive = audits.trust.filter(function(item) { return item.verification !== 'unmeasured' && item.points > 0; });
  if (trustUnavailable.length) {
    trust.analysis = 'CHOIVE could not complete ' + trustUnavailable.map(function(item) { return item.label.toLowerCase(); }).join(' or ')
      + ' during this run. Those checks were excluded from the score. '
      + (trustPositive.length
        ? 'The completed checks that earned points are listed in the ledger below.'
        : 'The other completed trust checks did not provide enough qualifying evidence to earn points.');
  } else {
    trust.analysis = trustPositive.length
      ? 'The trust score comes from the qualifying evidence listed in the ledger below. Checks that earned no points are also shown.'
      : 'CHOIVE completed the trust checks but did not find qualifying review, authority, reputation, or customer-result evidence in this run.';
  }
  trust.evidence = auditEvidenceText(audits.trust);

  result.pillars.difference.analysis = 'Difference answers one question: can a buyer quickly see why to pick this business instead of another? '
    + 'The score below only counts proof that is actually on the website — a clear "what makes us different" statement, a named client or partner, a niche you own, and a real result you can point to. '
    + 'The strongest fix is to say plainly, in your own words, what you do that your competitors do not, and give it its own page so both people and AI can find it.';
  result.pillars.difference.evidence = auditEvidenceText(audits.difference);
}

function reconcileActionsWithLedger(result, audits) {
  if (!Array.isArray(result.actions)) return;
  var reviewsUnavailable = audits.trust.some(function(item) {
    return (item.ruleId === 'TR-01' || item.ruleId === 'TR-02') && item.verification === 'unmeasured';
  });
  result.actions = result.actions.map(function(action) {
    if (!action || typeof action !== 'object') return action;
    var copy = Object.assign({}, action);
    var joined = [copy.title, copy.body, copy.explanation, copy.if_nothing].join(' ');
    if (reviewsUnavailable && /review|trustpilot|google business profile/i.test(joined)) {
      var instruction = String(copy.body || '').replace(/^.*?(?=(?:Check|The owner should|Ask|Invite)\b)/i, '');
      copy.body = 'CHOIVE could not complete the external review-profile and review-count checks during this run. This is not proof that no reviews exist. '
        + (instruction || 'Check whether the relevant profiles already exist before creating or claiming them, then invite confirmed customers to leave honest reviews.');
    }
    ['body', 'explanation', 'if_nothing'].forEach(function(field) {
      var text = String(copy[field] || '');
      text = text.replace(/When this page exists with structured, verifiable content, AI systems have a factual basis to include[^.]*\./gi,
        'This page would give AI systems clearer public evidence about the business. A new diagnostic is required to measure whether inclusion changes.');
      text = text.replace(/\b(?:will|would) cause AI (?:systems )?to (?:include|recommend|select)[^.]*\./gi,
        'A new diagnostic is required to measure whether AI inclusion changes after publication.');
      copy[field] = text;
    });
    return copy;
  });
}

function easeEntries(evidence, result) {
  var s = safeObject(evidence.websiteSignals);
  var root = siteUrl(evidence, '/');
  var siteDown = websiteUnavailable(evidence);
  // The crawler probe is only a measurement when at least one bot request
  // completed. A null result (probe threw) and an all-failed result (WAF block,
  // 429, timeout) are both absence of evidence. Scoring them as a confirmed 0/8
  // charged up to 8 of Ease's 25 points to a network condition — while the
  // observed string on the same row read "Not verified".
  var crawlerUnmeasured = siteDown
    || s.botCrawlable === null || s.botCrawlable === undefined || s.allBotsFailed === true;
  var crawlerPoints = s.botCrawlable === true && !s.botEmptyShellDetected ? 8 : 0;
  var crawlerDetail = crawlerUnmeasured
    ? (s.allBotsFailed ? 'Not measured — every AI crawler request failed or was blocked' : 'Not measured')
    : (crawlerPoints ? 'Substantive content returned' : 'Confirmed empty or partial response');
  return [
    mechanicalEntry(siteDown, 'EA-01', 'Schema markup', s.hasSchema ? 3 : 0, 3, safeArray(s.schemaTypes).join(', ') || 'Not detected', root),
    mechanicalEntry(siteDown, 'EA-02', 'Category-specific schema', s.hasSpecificSchema ? 4 : 0, 4, s.hasSpecificSchema ? 'Detected' : 'Not detected', root),
    mechanicalEntry(siteDown, 'EA-03', 'llms.txt', s.hasLlmsTxt ? 3 : 0, 3, s.hasLlmsTxt ? 'Fetched successfully' : 'Not fetched', siteUrl(evidence, '/llms.txt')),
    mechanicalEntry(siteDown, 'EA-04', 'Sitemap', s.hasSitemap ? 3 : 0, 3, s.hasSitemap ? 'Fetched successfully' : 'Not fetched', siteUrl(evidence, '/sitemap.xml')),
    mechanicalEntry(siteDown, 'EA-05', 'Robots file', s.hasRobots ? 2 : 0, 2, s.hasRobots ? 'Fetched successfully' : 'Not fetched', siteUrl(evidence, '/robots.txt')),
    entry('EA-06', 'AI crawler accessibility', crawlerPoints, 8, crawlerDetail, root, crawlerUnmeasured ? 'unmeasured' : 'mechanical'),
    auditEntry('EA-07', 'Structured FAQ or explainer', 2, result, 'ease', 'Structured FAQ', root)
  ];
}

function applyDeterministicScoring(evidence, result) {
  evidence = safeObject(evidence);
  result = safeObject(result);
  var audits = {
    clarity: clarityEntries(evidence, result),
    trust: trustEntries(evidence),
    difference: differenceEntries(evidence, result),
    ease: easeEntries(evidence, result)
  };
  var keys = ['clarity', 'trust', 'difference', 'ease'];
  result.pillars = safeObject(result.pillars);
  keys.forEach(function(key) {
    result.pillars[key] = safeObject(result.pillars[key]);
    result.pillars[key].score = score(audits[key]);
    result.pillars[key].confidence = confidence(audits[key]);
    result.pillars[key].measurement = measurementCoverage(audits[key]);
    // A pillar measured below the extrapolation floor has too little public
    // data to earn a fair 0–25 score. It is marked provisional so a broken
    // measurement run — an outage on the review or independent-search
    // provider — is never shown to the owner as a real, earned zero. A pillar
    // that WAS fully checked and simply found nothing (measured points cover
    // most of the rubric) is a genuine low score and stays as-is.
    var cover = result.pillars[key].measurement;
    var coverageRatio = cover.totalPoints ? cover.measuredPoints / cover.totalPoints : 0;
    result.pillars[key].provisional = cover.measuredPoints > 0
      && !cover.complete
      && coverageRatio < MIN_EXTRAPOLATION_COVERAGE;
  });
  reconcileNarrativeWithLedger(result, audits);
  reconcileActionsWithLedger(result, audits);
  // Only the pillars we could actually measure define the headline score. When
  // a pillar is provisional (its providers did not respond), we average the
  // measured pillars and rescale to 100. This keeps one failed measurement leg
  // from dragging the overall score down as if the business had genuinely
  // scored zero there. When nothing is provisional the score is the plain sum
  // of the four pillars (each 0–25), exactly as before.
  var scoredKeys = keys.filter(function(key) { return !result.pillars[key].provisional; });
  var provisionalKeys = keys.filter(function(key) { return result.pillars[key].provisional; });
  result.scoredPillarCount = scoredKeys.length;
  result.provisionalPillars = provisionalKeys;
  if (provisionalKeys.length && scoredKeys.length) {
    var scoredSum = scoredKeys.reduce(function(total, key) {
      return total + Number(result.pillars[key].score || 0);
    }, 0);
    result.overallScore = Math.round(scoredSum / (scoredKeys.length * 25) * 100 * 10) / 10;
    result.overallProvisional = true;
    result.overallNote = 'This score is based on the ' + scoredKeys.length + ' of 4 areas CHOIVE could fully measure in this run. '
      + provisionalKeys.map(function(k) { return k.charAt(0).toUpperCase() + k.slice(1); }).join(' and ')
      + ' could not be measured because a data provider did not respond, so it is not counted as a zero. Run the check again to score it.';
  } else {
    result.overallScore = Math.round(keys.reduce(function(total, key) {
      return total + Number(result.pillars[key].score || 0);
    }, 0) * 10) / 10;
    result.overallProvisional = false;
  }
  var clarityAudit = audits.clarity;
  var trustAudit = audits.trust;
  var differenceAudit = audits.difference;
  var easeAudit = audits.ease;
  var reviewsAwarded = trustAudit[0].points + trustAudit[1].points;
  var independentAwarded = trustAudit[2].points + trustAudit[3].points;
  if (clarityAudit[1].points === 0 && clarityAudit[4].points > 0) {
    result.pillars.clarity.finding = 'Offer explained, primary H1 missing';
  } else if (clarityAudit[1].points === 0) {
    result.pillars.clarity.finding = 'Primary offer and H1 are not established';
  } else if (clarityAudit[4].points === 0) {
    result.pillars.clarity.finding = 'Primary H1 present; offer explanation remains incomplete';
  } else {
    result.pillars.clarity.finding = result.pillars.clarity.score >= 19
      ? 'Offer and audience are clearly explained'
      : 'Core offer is only partly explained';
  }
  result.pillars.trust.finding = result.pillars.trust.provisional
    ? 'Trust could not be measured in this run — the review and independent-search checks did not return. This is not a zero; it needs another run.'
    : result.pillars.trust.score >= 18
      ? 'Independent sources give buyers strong reasons to trust this business'
      : 'CHOIVE found too little independent proof from reviews, press, or customer results';
  result.pillars.difference.finding = result.pillars.difference.provisional
    ? 'Difference could not be measured in this run. This is not a zero; it needs another run.'
    : result.pillars.difference.score >= 18
      ? 'The business clearly proves why a customer should choose it'
      : 'The website does not yet say clearly what makes this business different from its competitors';
  result.pillars.ease.finding = result.pillars.ease.score >= 20
    ? 'The website is easy for search engines and AI systems to read'
    : 'Parts of the website are still difficult for search engines or AI systems to verify';
  if (result.overallScore >= 76) {
    result.verdictLevel = 'present';
    result.verdictHeadline = 'Strong public evidence across the four pillars';
  } else if (result.overallScore >= 56) {
    result.verdictLevel = 'present';
    result.verdictHeadline = 'Public evidence is present, with specific gaps';
  } else if (result.overallScore >= 31) {
    result.verdictLevel = 'weak';
    result.verdictHeadline = 'Public evidence needs improvement';
  } else {
    result.verdictLevel = 'absent';
    result.verdictHeadline = 'Public evidence is incomplete';
  }
  var allEntries = [].concat(audits.clarity, audits.trust, audits.difference, audits.ease);
  result.scoreMethod = {
    version: RUBRIC_VERSION,
    generatedAt: evidence.collectedAt || new Date().toISOString(),
    policy: 'Code allocates points from recorded evidence statuses. Interpreted evidence is labelled model_assessed and carries lower confidence.',
    audits: audits,
    confidence: confidence(allEntries)
  };
  result.measurementStandard = measurementProvenance(result.scoreMethod.generatedAt);
  return result;
}

module.exports = { applyDeterministicScoring: applyDeterministicScoring };
