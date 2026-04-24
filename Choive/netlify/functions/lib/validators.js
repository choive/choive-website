// lib/validators.js
// CHOIVE™ validation, normalization, score clamping, safe result shaping

function validateInput(body) {
  const { name, category, city } = body || {};
  const missing = [];

  if (!name || !String(name).trim()) missing.push('name');
  if (!category || !String(category).trim()) missing.push('category');
  if (!city || !String(city).trim()) missing.push('city');

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing required fields: ${missing.join(', ')}`
    };
  }

  return { valid: true };
}

function clampScore(n) {
  return Math.max(0, Math.min(25, Number(n) || 0));
}

function safeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim() || fallback;
}

const VALID_VERDICT_LEVELS = ['absent', 'weak', 'present'];
const VALID_DECISION_STATES = [
  'not_seen',
  'seen_not_considered',
  'considered_not_chosen',
  'trusted_not_chosen',
  'chosen_by_default'
];
const VALID_PLATFORM_STATUSES = ['absent', 'weak', 'present'];
const VALID_TIERS = ['dominant', 'strong', 'upper_mid', 'mid', 'weak', 'absent', 'unknown'];
const VALID_ACTION_PRIORITIES = ['critical', 'high', 'medium', 'low'];

function hasValidShape(output) {
  if (!output || typeof output !== 'object') return false;

  const p = output.pillars;
  const pc = output.platformCoverage;
  const mp = output.marketPosition;

  if (!p || typeof p !== 'object') return false;
  if (!pc || typeof pc !== 'object') return false;
  if (!mp || typeof mp !== 'object') return false;

  const requiredPillars = ['clarity', 'trust', 'difference', 'ease'];
  const requiredPlatforms = ['chatgpt', 'perplexity', 'gemini', 'claude'];

  for (const pillar of requiredPillars) {
    if (!p[pillar] || typeof p[pillar] !== 'object') return false;
    if (typeof p[pillar].score !== 'number') return false;
  }

  for (const platform of requiredPlatforms) {
    if (!pc[platform] || typeof pc[platform] !== 'object') return false;
  }

  return true;
}

function normalizePillar(pillar, fallbackFinding) {
  return {
    score: clampScore(pillar?.score),
    finding: safeString(pillar?.finding, fallbackFinding)
  };
}

function normalizePlatform(platform) {
  const status = VALID_PLATFORM_STATUSES.includes(platform?.status)
    ? platform.status
    : 'absent';

  return {
    status,
    detail: safeString(platform?.detail, 'No data available.')
  };
}

function normalizeAction(action, fallbackPriority = 'medium') {
  const priority = VALID_ACTION_PRIORITIES.includes(action?.priority)
    ? action.priority
    : fallbackPriority;

  return {
    priority,
    title: safeString(action?.title, 'Untitled action'),
    body: safeString(action?.body, 'No action detail provided.')
  };
}

function buildSafeOutput(output) {
  const safe = {
    overallScore: typeof output?.overallScore === 'number' ? output.overallScore : 0,
    verdictHeadline: safeString(output?.verdictHeadline, 'Diagnostic incomplete'),
    verdictLevel: VALID_VERDICT_LEVELS.includes(output?.verdictLevel)
      ? output.verdictLevel
      : 'absent',
    signatureLine: safeString(output?.signatureLine, 'Present — but not chosen.'),
    decisionState: VALID_DECISION_STATES.includes(output?.decisionState)
      ? output.decisionState
      : 'considered_not_chosen',
    summaryParagraph: safeString(
      output?.summaryParagraph,
      'The diagnostic could not fully assess this business.'
    ),
    businessUnderstanding: safeString(output?.businessUnderstanding, ''),
    marketPosition: {
      tier: VALID_TIERS.includes(output?.marketPosition?.tier)
        ? output.marketPosition.tier
        : 'unknown',
      label: safeString(output?.marketPosition?.label, 'Unknown position'),
      explanation: safeString(output?.marketPosition?.explanation, '')
    },
    evidenceNarrative: safeString(
      output?.evidenceNarrative,
      'No evidence narrative available.'
    ),
    pillars: {
      clarity: normalizePillar(output?.pillars?.clarity, 'Clarity could not be confirmed.'),
      trust: normalizePillar(output?.pillars?.trust, 'Trust could not be confirmed.'),
      difference: normalizePillar(output?.pillars?.difference, 'Difference could not be confirmed.'),
      ease: normalizePillar(output?.pillars?.ease, 'Ease could not be confirmed.')
    },
    platformCoverage: {
      chatgpt: normalizePlatform(output?.platformCoverage?.chatgpt),
      perplexity: normalizePlatform(output?.platformCoverage?.perplexity),
      gemini: normalizePlatform(output?.platformCoverage?.gemini),
      claude: normalizePlatform(output?.platformCoverage?.claude)
    },
    actions: Array.isArray(output?.actions) && output.actions.length > 0
      ? output.actions.map((action, index) =>
          normalizeAction(action, index < 2 ? 'critical' : index === 2 ? 'high' : 'medium')
        )
      : [
          {
            priority: 'critical',
            title: 'Retry diagnostic',
            body: 'The engine did not return a complete result. Please try again.'
          }
        ]
  };

  const c = clampScore(safe.pillars.clarity.score);
  const t = clampScore(safe.pillars.trust.score);
  const d = clampScore(safe.pillars.difference.score);
  const e = clampScore(safe.pillars.ease.score);
  safe.pillars.clarity.score = c;
  safe.pillars.trust.score = t;
  safe.pillars.difference.score = d;
  safe.pillars.ease.score = e;

  safe.overallScore = c + t + d + e;

  const marketTier = safe.marketPosition.tier;

  if (safe.overallScore <= 30) {
    safe.verdictLevel = 'absent';
    safe.verdictHeadline = 'Not the obvious choice — losing decisions';
  } else if (
    safe.overallScore <= 55 ||
    e < 12 ||
    ['upper_mid', 'mid', 'weak', 'absent', 'unknown'].includes(marketTier)
  ) {
    safe.verdictLevel = 'weak';
    safe.verdictHeadline = 'Not consistently the obvious choice — losing opportunities';
  } else {
    safe.verdictLevel = 'present';
    safe.verdictHeadline = 'The obvious choice — winning decisions';
  }

  return safe;
}

module.exports = {
  validateInput,
  clampScore,
  hasValidShape,
  buildSafeOutput
};
