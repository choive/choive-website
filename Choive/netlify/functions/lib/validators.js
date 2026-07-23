// lib/validators.js
// Input validation, result shape validation, score clamping
//
// CHANGE FROM PREVIOUS VERSION:
// The regex-based ease score floor (scanning Claude's evidence text for
// "schema found: yes") has been removed. Schema presence is now confirmed
// mechanically in fetchWebsite.js and applied as hard constraints in
// claude.js (applySignalConstraints) before this function runs.
// Everything else is identical.

function validPublicWebsite(value) {
  if (!value) return true;
  try {
    var raw = String(value).trim();
    var parsed = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return false;
    var host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
    var match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (match) {
      var octets = match.slice(1).map(Number);
      if (octets.some(function(octet) { return octet > 255; })) return false;
      if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0
        || (octets[0] === 169 && octets[1] === 254)
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)) return false;
    }
    return host.indexOf('.') !== -1 || match !== null;
  } catch (_) {
    return false;
  }
}

function validateInput(body) {
  const { name, category, city, marketReach } = body || {};
  const missing = [];
  if (!name || !String(name).trim()) missing.push('name');
  if (!category || !String(category).trim()) missing.push('category');
  if (!city || !String(city).trim()) missing.push('city');
  if (!marketReach || !['local', 'regional', 'national', 'international', 'global'].includes(String(marketReach).trim().toLowerCase())) missing.push('market reach');
  if (missing.length > 0) {
    return { valid: false, error: 'Missing required fields: ' + missing.join(', ') };
  }
  var limits = { name: 160, category: 240, city: 160, website: 500, description: 1000, knownCompetitors: 500, customerQuestion: 500, marketReach: 20 };
  for (var field in limits) {
    if (String((body || {})[field] || '').length > limits[field]) {
      return { valid: false, error: field + ' is too long' };
    }
  }
  if (!validPublicWebsite((body || {}).website)) {
    return { valid: false, error: 'Website must be a public http(s) address' };
  }
  var subjectType = String((body || {}).subjectType || 'business');
  if (['business', 'product', 'creator', 'personal_brand', 'organization'].indexOf(subjectType) === -1) {
    return { valid: false, error: 'Invalid subject type' };
  }
  return { valid: true };
}

function clampScore(n) {
  return Math.max(0, Math.min(25, Number(n) || 0));
}

const VALID_VERDICT_LEVELS    = ['absent', 'weak', 'present'];
const VALID_DECISION_STATES   = ['not_seen', 'seen_not_considered', 'considered_not_chosen', 'trusted_not_chosen', 'chosen_by_default'];
const VALID_PLATFORM_STATUSES = ['absent', 'weak', 'present', 'partial', 'failed', 'unmeasured'];
const VALID_TIERS             = ['dominant', 'strong', 'upper_mid', 'mid', 'weak', 'absent'];
const VALID_DECISION_ENVS     = ['discovery_driven', 'comparison_driven', 'authority_driven', 'default_driven'];

function hasValidShape(output) {
  if (!output || typeof output !== 'object') return false;
  const p  = output.pillars;
  const pc = output.platformCoverage;
  return (
    p && pc &&
    p.clarity && p.trust && p.difference && p.ease &&
    pc.chatgpt && pc.perplexity && pc.gemini && pc.claude &&
    typeof p.clarity.score    === 'number' &&
    typeof p.trust.score      === 'number' &&
    typeof p.difference.score === 'number' &&
    typeof p.ease.score       === 'number'
  );
}

function normalizePillar(raw) {
  if (!raw || typeof raw !== 'object') {
    return { score: 0, finding: 'Insufficient data.', analysis: '', evidence: '' };
  }
  return {
    score:    typeof raw.score === 'number' ? raw.score : 0,
    finding:  raw.finding  || 'Insufficient data.',
    analysis: raw.analysis || '',
    evidence: raw.evidence || ''
  };
}

function normalizeCoverage(raw, platform) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      status: 'unmeasured',
      detail: platform + ' did not return a completed provider measurement.'
    };
  }
  return {
    status: VALID_PLATFORM_STATUSES.includes(raw.status) ? raw.status : 'unmeasured',
    detail: raw.detail || (platform + ' measurement status was not established.')
  };
}

function resolveDisplacement(output) {
  const empty = { competitorName: '', competitorWhy: '', competitorQuery: '' };
  if (output && output.competitor && output.competitor.name) {
    return {
      competitorName:  output.competitor.name        || '',
      competitorWhy:   output.competitor.analysis    || '',
      competitorQuery: output.competitor.queryContext || ''
    };
  }
  if (output && output.displacement && output.displacement.competitorName) {
    return {
      competitorName:  output.displacement.competitorName  || '',
      competitorWhy:   output.displacement.competitorWhy   || '',
      competitorQuery: output.displacement.competitorQuery || ''
    };
  }
  return empty;
}

function buildSafeOutput(output) {
  const tierLabels = {
    dominant: 'Category leader',
    strong: 'Strong market position',
    upper_mid: 'Established but not dominant',
    mid: 'Recognized in part of the market',
    weak: 'Limited market recognition',
    absent: 'Not established in the measured market',
    unknown: 'Market position was not established'
  };
  const normalizedTier = VALID_TIERS.includes(output?.marketPosition?.tier)
    ? output.marketPosition.tier : 'unknown';

  const safe = {
    overallScore:          typeof output?.overallScore === 'number' ? output.overallScore : 0,
    inferredCategory:      output?.inferredCategory      || '',
    verdictHeadline:       output?.verdictHeadline        || 'Diagnostic incomplete',
    verdictLevel:          VALID_VERDICT_LEVELS.includes(output?.verdictLevel) ? output.verdictLevel : 'absent',
    signatureLine:         output?.signatureLine           || 'The diagnostic did not return enough completed platform answers to state a recommendation result.',
    decisionState:         VALID_DECISION_STATES.includes(output?.decisionState) ? output.decisionState : 'considered_not_chosen',
    decisionEnvironment:   VALID_DECISION_ENVS.includes(output?.decisionEnvironment) ? output.decisionEnvironment : '',
    summaryParagraph:      output?.summaryParagraph        || 'The diagnostic could not fully assess this business.',
    businessUnderstanding: output?.businessUnderstanding   || '',
    marketPosition: {
      tier:        normalizedTier,
      label:       output?.marketPosition?.label || tierLabels[normalizedTier],
      explanation: output?.marketPosition?.explanation || output?.marketPosition?.reasoning
        || 'The available evidence did not establish a more specific market position.'
    },
    evidenceNarrative: output?.evidenceNarrative || 'No evidence narrative available.',
    pillars: {
      clarity:    normalizePillar(output?.pillars?.clarity),
      trust:      normalizePillar(output?.pillars?.trust),
      difference: normalizePillar(output?.pillars?.difference),
      ease:       normalizePillar(output?.pillars?.ease)
    },
    platformCoverage: {
      chatgpt:    normalizeCoverage(output?.platformCoverage?.chatgpt, 'ChatGPT'),
      perplexity: normalizeCoverage(output?.platformCoverage?.perplexity, 'Perplexity'),
      gemini:     normalizeCoverage(output?.platformCoverage?.gemini, 'Gemini'),
      claude:     normalizeCoverage(output?.platformCoverage?.claude, 'Claude')
    },
    actions: Array.isArray(output?.actions) && output.actions.length > 0
      ? output.actions
      : [{ priority: 'critical', title: 'Retry diagnostic', body: 'The engine did not return a complete result. Please try again.' }],
    displacement:   resolveDisplacement(output),
    competitors:    Array.isArray(output && output.competitors)   ? output.competitors   : [],
    socialSignals:  (output && output.socialSignals && typeof output.socialSignals === 'object') ? output.socialSignals : {},
    summaries:      (output && output.summaries    && typeof output.summaries    === 'object') ? output.summaries    : {},
    signalAudit:    (output && output.signalAudit  && typeof output.signalAudit  === 'object') ? output.signalAudit  : { clarity: [], trust: [], difference: [], ease: [] }
  };

  // ── Validate platform statuses ────────────────────────────────────────────
  for (const platform of ['chatgpt', 'perplexity', 'gemini', 'claude']) {
    const s = safe.platformCoverage[platform].status;
    if (!VALID_PLATFORM_STATUSES.includes(s)) {
      safe.platformCoverage[platform].status = 'absent';
    }
  }

  // ── Clamp pillar scores ───────────────────────────────────────────────────
  // Signal-based floors and ceilings are applied in claude.js before this runs.
  // This function only clamps to the valid range (0-25). Market position is a
  // separate finding and must never manufacture pillar points.
  const cs    = clampScore(safe.pillars.clarity.score);
  const ts    = clampScore(safe.pillars.trust.score);
  const ds    = clampScore(safe.pillars.difference.score);
  const es    = clampScore(safe.pillars.ease.score);

  safe.pillars.clarity.score    = cs;
  safe.pillars.trust.score      = ts;
  safe.pillars.difference.score = ds;
  safe.pillars.ease.score       = es;

  // ── Market tier ───────────────────────────────────────────────────────────
  const marketTier = safe.marketPosition.tier;
  const isDominant = marketTier === 'dominant';
  const isStrong   = marketTier === 'strong';

  // ── Difference floor: dominant/strong brands ──────────────────────────────
  safe.pillars.difference.score = ds;

  // ── Trust floor: dominant brands ──────────────────────────────────────────
  safe.pillars.trust.score = ts;

  // ── Overall score ─────────────────────────────────────────────────────────
  safe.overallScore = cs + ts + ds + es;

  // Structural evidence fallback only. Actual platform measurements are
  // attached later by the background diagnostic.
  if (isDominant) {
    safe.verdictLevel    = 'present';
    safe.verdictHeadline = 'Strong public evidence across all four pillars';
  } else if (isStrong && safe.overallScore >= 40) {
    safe.verdictLevel    = 'present';
    safe.verdictHeadline = 'Strong public evidence with specific gaps';
  } else if (safe.overallScore <= 30) {
    safe.verdictLevel    = 'absent';
    safe.verdictHeadline = 'Public evidence is incomplete';
  } else if (
    safe.overallScore <= 55 ||
    es < 12 ||
    ['upper_mid', 'mid', 'weak', 'absent', 'unknown'].includes(marketTier)
  ) {
    safe.verdictLevel    = 'weak';
    // This exact phrase was independently banned at the MODEL level in
    // claude.js's prompt (AVOID AMBIGUOUS NEGATION rule) \u2014 but this hardcoded
    // override in buildSafeOutput runs AFTER the model responds and was
    // silently replacing whatever headline the model correctly wrote,
    // completely bypassing that fix for every result landing in this score
    // range. "Not consistently X" reads as "usually X, sometimes not" \u2014
    // backwards for a weak-tier business that is not the default choice.
    safe.verdictHeadline = 'Public evidence needs improvement';
  } else {
    safe.verdictLevel    = 'present';
    safe.verdictHeadline = 'Public evidence is largely established';
  }

  return safe;
}

module.exports = { validateInput, clampScore, hasValidShape, buildSafeOutput };
