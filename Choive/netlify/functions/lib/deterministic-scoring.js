// CHOIVE point allocation from recorded evidence.
//
// Code, not model-proposed numbers, allocates every point. Some inputs are
// mechanically observed and some are explicitly labelled model_assessed. The
// ledger keeps that distinction visible instead of presenting interpretation
// as mechanical fact.

'use strict';

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
    points: clamp(points, maxPoints),
    maxPoints: maxPoints,
    observed: String(observed || 'Not established'),
    source: source || '',
    verification: verification
  };
}

function score(entries) {
  return Math.round(entries.reduce(function(total, item) { return total + item.points; }, 0) * 10) / 10;
}

function confidence(entries) {
  var possible = entries.reduce(function(total, item) { return total + item.maxPoints; }, 0);
  var verified = entries.reduce(function(total, item) {
    return total + (item.verification === 'mechanical' || item.verification === 'independent' ? item.maxPoints : 0);
  }, 0);
  var ratio = possible ? verified / possible : 0;
  return {
    level: ratio >= 0.8 ? 'high' : ratio >= 0.5 ? 'medium' : 'low',
    score: Math.round(ratio * 100),
    basis: 'Percentage of this rubric verified mechanically or through independently retrieved sources.'
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
    return !name || text.toLowerCase().indexOf(name) !== -1;
  });
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
  var unavailable = !verified
    && (measurement.trustpilot === 'unavailable' || measurement.googleReviews === 'unavailable');
  return { verified: verified, count: count, platforms: platforms, source: source, unavailable: unavailable };
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
  return [
    entry('CL-01', 'Page title present', s.hasTitle ? 3 : 0, 3, s.titleText || 'Not detected', root, 'mechanical'),
    entry('CL-02', 'Primary H1 present', s.hasH1 ? 3 : 0, 3, s.h1Text || 'Not detected', root, 'mechanical'),
    entry('CL-03', 'Meta description present', s.hasMetaDescription ? 3 : 0, 3, s.metaDescriptionText || 'Not detected', root, 'mechanical'),
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
  var authority = independentResults(evidence, 'authority').slice(0, 4);
  var reputation = independentResults(evidence, 'reputation').slice(0, 3);
  var proofMatch = String(evidence.websiteText || '').match(/PUBLIC PROOF PAGE CONTENT:\s*([\s\S]+)/i);
  var proofLength = proofMatch ? String(proofMatch[1] || '').trim().length : 0;
  return [
    entry('TR-01', 'Verified external review record', reviews.verified ? reviewIdentityMax : 0, reviewIdentityMax, reviews.verified ? (reviews.platforms.join(', ') || 'Verified review record') : (reviews.unavailable ? 'Not verified — review provider unavailable during this run' : 'No verified review record found'), reviews.source, reviews.unavailable ? 'unmeasured' : 'independent'),
    entry('TR-02', 'Verified review volume', scaledReviewPoints(reviews.count, reviewVolumeMax), reviewVolumeMax, reviews.verified ? (reviews.count + ' verified reviews') : (reviews.unavailable ? 'Review count not verified — provider unavailable' : 'No verified review count found'), reviews.source, reviews.unavailable ? 'unmeasured' : 'independent'),
    entry('TR-03', 'Independent authority coverage', Math.min(authorityMax, authority.length * (authorityMax / 4)), authorityMax, authority.length + ' relevant independent result(s)', authority.map(function(item) { return item.link; }), 'independent'),
    entry('TR-04', 'Independent reputation evidence', Math.min(reputationMax, reputation.length * (reputationMax / 3)), reputationMax, reputation.length + ' relevant independent result(s)', reputation.map(function(item) { return item.link; }), 'independent'),
    entry('TR-05', 'Substantive proof on owned pages', proofLength >= 120 ? proofMax : 0, proofMax, proofLength ? proofLength + ' proof-page characters collected' : 'Not detected', siteUrl(evidence, '/case-studies'), 'mechanical')
  ];
}

function differenceEntries(evidence, result) {
  var root = siteUrl(evidence, '/');
  return [
    auditEntry('DI-01', 'Specific differentiator stated', 7, result, 'difference', 'Named differentiator', root),
    auditEntry('DI-02', 'Named client or partner', 6, result, 'difference', 'Named client or partner', root),
    auditEntry('DI-03', 'Defined niche or category position', 6, result, 'difference', 'Niche or category', root),
    auditEntry('DI-04', 'Measurable outcome proof', 6, result, 'difference', 'Proof of outcome', root)
  ];
}

function easeEntries(evidence, result) {
  var s = safeObject(evidence.websiteSignals);
  var root = siteUrl(evidence, '/');
  var crawlerPoints = s.botCrawlable === true && !s.botEmptyShellDetected ? 8 : 0;
  var crawlerDetail = s.botCrawlable === null || s.botCrawlable === undefined
    ? 'Not measured'
    : (crawlerPoints
      ? 'Substantive content returned'
      : (s.allBotsFailed ? 'Not verified — all bot requests failed or were blocked' : 'Confirmed empty or partial response'));
  return [
    entry('EA-01', 'Schema markup', s.hasSchema ? 3 : 0, 3, safeArray(s.schemaTypes).join(', ') || 'Not detected', root, 'mechanical'),
    entry('EA-02', 'Category-specific schema', s.hasSpecificSchema ? 4 : 0, 4, s.hasSpecificSchema ? 'Detected' : 'Not detected', root, 'mechanical'),
    entry('EA-03', 'llms.txt', s.hasLlmsTxt ? 3 : 0, 3, s.hasLlmsTxt ? 'Fetched successfully' : 'Not fetched', siteUrl(evidence, '/llms.txt'), 'mechanical'),
    entry('EA-04', 'Sitemap', s.hasSitemap ? 3 : 0, 3, s.hasSitemap ? 'Fetched successfully' : 'Not fetched', siteUrl(evidence, '/sitemap.xml'), 'mechanical'),
    entry('EA-05', 'Robots file', s.hasRobots ? 2 : 0, 2, s.hasRobots ? 'Fetched successfully' : 'Not fetched', siteUrl(evidence, '/robots.txt'), 'mechanical'),
    entry('EA-06', 'AI crawler accessibility', crawlerPoints, 8, crawlerDetail, root, 'mechanical'),
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
  });
  result.overallScore = Math.round(keys.reduce(function(total, key) {
    return total + Number(result.pillars[key].score || 0);
  }, 0) * 10) / 10;
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
  result.pillars.trust.finding = reviewsAwarded === 0 && independentAwarded > 0
    ? 'Independent mentions found; buyer proof missing'
    : (result.pillars.trust.score >= 18 ? 'Independent trust evidence is established' : 'Independent buyer proof remains limited');
  result.pillars.difference.finding = differenceAudit[0].points > 0 && differenceAudit[3].points === 0
    ? 'Specific distinction lacks measurable outcome proof'
    : (result.pillars.difference.score >= 18 ? 'Specific distinction is supported by proof' : 'Distinctive evidence remains incomplete');
  result.pillars.ease.finding = result.pillars.ease.score >= 20
    ? 'Technical access is strongly established'
    : (result.pillars.ease.score >= 12 ? 'Technical access has specific gaps' : 'Technical access is incomplete');
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
    version: 'evidence-rubric-v2',
    generatedAt: evidence.collectedAt || new Date().toISOString(),
    policy: 'Code allocates points from recorded evidence statuses. Interpreted evidence is labelled model_assessed and carries lower confidence.',
    audits: audits,
    confidence: confidence(allEntries)
  };
  return result;
}

module.exports = { applyDeterministicScoring: applyDeterministicScoring };
