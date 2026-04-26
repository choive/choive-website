// lib/validators.js
// Input validation, result shape validation, score clamping
// Supports both old (displacement) and new (competitor) Claude output shapes

function validateInput(body) {
  const { name, category, city } = body || {};
  const missing = [];
  if (!name || !String(name).trim()) missing.push('name');
  if (!category || !String(category).trim()) missing.push('category');
  if (!city || !String(city).trim()) missing.push('city');
  if (missing.length > 0) {
    return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
  }
  return { valid: true };
}

function clampScore(n) {
  return Math.max(0, Math.min(25, Number(n) || 0));
}

const VALID_VERDICT_LEVELS   = ['absent', 'weak', 'present'];
const VALID_DECISION_STATES  = ['not_seen', 'seen_not_considered', 'considered_not_chosen', 'trusted_not_chosen', 'chosen_by_default'];
const VALID_PLATFORM_STATUSES = ['absent', 'weak', 'present'];
const VALID_TIERS            = ['dominant', 'strong', 'upper_mid', 'mid', 'weak', 'absent', 'unknown'];
const DOMINANT_TIERS         = ['dominant', 'strong'];

const VALID_DECISION_ENVS = ['discovery_driven', 'comparison_driven', 'authority_driven', 'default_driven'];

function hasValidShape(output) {
  if (!output || typeof output !== 'object') return false;
  const p  = output.pillars;
  const pc = output.platformCoverage;
  return (
    p && pc &&
    p.clarity && p.trust && p.difference && p.ease &&
    pc.chatgpt && pc.perplexity && pc.gemini && pc.claude &&
    !isNaN(Number(p.clarity.score)) &&
    !isNaN(Number(p.trust.score)) &&
    !isNaN(Number(p.difference.score)) &&
    !isNaN(Number(p.ease.score))
  );
}

// ── Normalize a single pillar ────────────────────────────────────────────────
// Accepts both old shape { score, finding } and new shape { score, finding, analysis, evidence }
function normalizePillar(raw) {
  if (!raw || typeof raw !== 'object') {
    return { score: 0, finding: 'Insufficient data.', analysis: '', evidence: '' };
  }
  function normalizePillar(raw) {
  if (!raw || typeof raw !== 'object') {
    return { score: 0, finding: 'Insufficient data.', analysis: '', evidence: '' };
  }

  return {
    score: !isNaN(Number(raw.score)) ? Number(raw.score) : 0,
    finding: raw.finding || 'Insufficient data.',
    analysis: raw.analysis || '',
    evidence: raw.evidence || ''
  };
}

// ── Resolve displacement from old or new competitor shape ────────────────────
// Old shape: output.displacement.competitorName / competitorWhy / competitorQuery
// New shape: output.competitor.name / analysis / queryContext
// Frontend always receives: displacement.competitorName / competitorWhy / competitorQuery
function resolveDisplacement(output) {
  const empty = { competitorName: '', competitorWhy: '', competitorQuery: '' };

  // Prefer new competitor field if present and has a name
  if (output?.competitor?.name) {
    return {
      competitorName:  output.competitor.name        || '',
      competitorWhy:   output.competitor.analysis    || '',
      competitorQuery: output.competitor.queryContext || ''
    };
  }

  // Fall back to old displacement field
  if (output?.displacement?.competitorName) {
    return {
      competitorName:  output.displacement.competitorName  || '',
      competitorWhy:   output.displacement.competitorWhy   || '',
      competitorQuery: output.displacement.competitorQuery || ''
    };
  }

  // No competitor — return empty (do not invent data)
  return empty;
}

function buildSafeOutput(output) {
  const fpl = { status: 'absent', detail: 'No data available.' };

  const safe = {
    overallScore:          typeof output?.overallScore === 'number' ? output.overallScore : 0,
    verdictHeadline:       output?.verdictHeadline       || 'Diagnostic incomplete',
    verdictLevel:          VALID_VERDICT_LEVELS.includes(output?.verdictLevel) ? output.verdictLevel : 'absent',
    signatureLine:         output?.signatureLine          || 'Present — but not chosen.',
    decisionState:         VALID_DECISION_STATES.includes(output?.decisionState) ? output.decisionState : 'considered_not_chosen',
    decisionEnvironment:   VALID_DECISION_ENVS.includes(output?.decisionEnvironment) ? output.decisionEnvironment : '',
    summaryParagraph:      output?.summaryParagraph       || 'The diagnostic could not fully assess this business.',
    businessUnderstanding: output?.businessUnderstanding  || '',
    marketPosition: {
      tier:        VALID_TIERS.includes(output?.marketPosition?.tier) ? output.marketPosition.tier : 'unknown',
      label:       output?.marketPosition?.label       || 'Unknown position',
      explanation: output?.marketPosition?.explanation || ''
    },
    evidenceNarrative: output?.evidenceNarrative || 'No evidence narrative available.',
    pillars: {
      clarity:    normalizePillar(output?.pillars?.clarity),
      trust:      normalizePillar(output?.pillars?.trust),
      difference: normalizePillar(output?.pillars?.difference),
      ease:       normalizePillar(output?.pillars?.ease)
    },
    platformCoverage: {
      chatgpt:    output?.platformCoverage?.chatgpt    || { ...fpl },
      perplexity: output?.platformCoverage?.perplexity || { ...fpl },
      gemini:     output?.platformCoverage?.gemini     || { ...fpl },
      claude:     output?.platformCoverage?.claude     || { ...fpl }
    },
    actions: Array.isArray(output?.actions) && output.actions.length > 0
      ? output.actions
      : [{ priority: 'critical', title: 'Retry diagnostic', body: 'The engine did not return a complete result. Please try again.' }],
    displacement: resolveDisplacement(output)
  };

  // Validate platform statuses
  for (const platform of ['chatgpt', 'perplexity', 'gemini', 'claude']) {
    const s = safe.platformCoverage[platform].status;
    if (!VALID_PLATFORM_STATUSES.includes(s)) {
      safe.platformCoverage[platform].status = 'absent';
    }
  }

  // Clamp pillar scores
  const cs = clampScore(safe.pillars.clarity.score);
  const ts = clampScore(safe.pillars.trust.score);
  const ds = clampScore(safe.pillars.difference.score);
  const es = clampScore(safe.pillars.ease.score);
  safe.pillars.clarity.score    = cs;
  safe.pillars.trust.score      = ts;
  safe.pillars.difference.score = ds;
  safe.pillars.ease.score       = es;

  // overallScore = deterministic sum of clamped pillars
  safe.overallScore = cs + ts + ds + es;

  const marketTier = safe.marketPosition.tier;
  const isDominant = DOMINANT_TIERS.includes(marketTier);

  // ── VERDICT OVERRIDE ─────────────────────────────────────────────────────
  // verdictLevel = recommendation likelihood (market position driven)
  // overallScore = AI readability (pillar evidence driven)
  // These are intentionally separate dimensions.

  if (isDominant) {
    safe.verdictLevel    = 'present';
    safe.verdictHeadline = 'Chosen by default — but infrastructure is exposed';
  } else if (safe.overallScore <= 30) {
    safe.verdictLevel    = 'absent';
    safe.verdictHeadline = 'Not the obvious choice — losing decisions';
  } else if (
    safe.overallScore <= 55 ||
    es < 12 ||
    ['upper_mid', 'mid', 'weak', 'absent', 'unknown'].includes(marketTier)
  ) {
    safe.verdictLevel    = 'weak';
    safe.verdictHeadline = 'Not consistently the obvious choice — losing opportunities';
  } else {
    safe.verdictLevel    = 'present';
    safe.verdictHeadline = 'The obvious choice — winning decisions';
  }

  return safe;
}

module.exports = { validateInput, clampScore, hasValidShape, buildSafeOutput };
