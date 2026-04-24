// lib/validators.js
// Input validation, result shape validation, score clamping

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

const VALID_VERDICT_LEVELS = ['absent', 'weak', 'present'];
const VALID_DECISION_STATES = ['not_seen', 'seen_not_considered', 'considered_not_chosen', 'trusted_not_chosen', 'chosen_by_default'];
const VALID_PLATFORM_STATUSES = ['absent', 'weak', 'present'];
const VALID_TIERS = ['dominant', 'strong', 'upper_mid', 'mid', 'weak', 'absent', 'unknown'];

// Market tiers that represent genuine recommendation strength
// dominant and strong = businesses AI will recommend regardless of schema gaps
const DOMINANT_TIERS = ['dominant', 'strong'];

function hasValidShape(output) {
  if (!output || typeof output !== 'object') return false;
  const p = output.pillars;
  const pc = output.platformCoverage;
  return (
    p && pc &&
    p.clarity && p.trust && p.difference && p.ease &&
    pc.chatgpt && pc.perplexity && pc.gemini && pc.claude &&
    typeof p.clarity.score === 'number' &&
    typeof p.trust.score === 'number' &&
    typeof p.difference.score === 'number' &&
    typeof p.ease.score === 'number'
  );
}

function buildSafeOutput(output) {
  const fp  = { score: 0, finding: 'Insufficient data.' };
  const fpl = { status: 'absent', detail: 'No data available.' };

  const safe = {
    overallScore:       typeof output?.overallScore === 'number' ? output.overallScore : 0,
    verdictHeadline:    output?.verdictHeadline  || 'Diagnostic incomplete',
    verdictLevel:       VALID_VERDICT_LEVELS.includes(output?.verdictLevel) ? output.verdictLevel : 'absent',
    signatureLine:      output?.signatureLine    || 'Present — but not chosen.',
    decisionState:      VALID_DECISION_STATES.includes(output?.decisionState) ? output.decisionState : 'considered_not_chosen',
    summaryParagraph:   output?.summaryParagraph || 'The diagnostic could not fully assess this business.',
    businessUnderstanding: output?.businessUnderstanding || '',
    marketPosition: {
      tier:        VALID_TIERS.includes(output?.marketPosition?.tier) ? output.marketPosition.tier : 'unknown',
      label:       output?.marketPosition?.label       || 'Unknown position',
      explanation: output?.marketPosition?.explanation || ''
    },
    evidenceNarrative: output?.evidenceNarrative || 'No evidence narrative available.',
    pillars: {
      clarity:    output?.pillars?.clarity    || { ...fp },
      trust:      output?.pillars?.trust      || { ...fp },
      difference: output?.pillars?.difference || { ...fp },
      ease:       output?.pillars?.ease       || { ...fp }
    },
    platformCoverage: {
      chatgpt:    output?.platformCoverage?.chatgpt    || { ...fpl },
      perplexity: output?.platformCoverage?.perplexity || { ...fpl },
      gemini:     output?.platformCoverage?.gemini     || { ...fpl },
      claude:     output?.platformCoverage?.claude     || { ...fpl }
    },
    actions: Array.isArray(output?.actions) && output.actions.length > 0
      ? output.actions
      : [{ priority: 'critical', title: 'Retry diagnostic', body: 'The engine did not return a complete result. Please try again.' }]
  };

  // Validate platform statuses
  for (const platform of ['chatgpt', 'perplexity', 'gemini', 'claude']) {
    const s = safe.platformCoverage[platform].status;
    if (!VALID_PLATFORM_STATUSES.includes(s)) {
      safe.platformCoverage[platform].status = 'absent';
    }
  }

  // Clamp all pillar scores
  const c = clampScore(safe.pillars.clarity.score);
  const t = clampScore(safe.pillars.trust.score);
  const d = clampScore(safe.pillars.difference.score);
  const e = clampScore(safe.pillars.ease.score);
  safe.pillars.clarity.score    = c;
  safe.pillars.trust.score      = t;
  safe.pillars.difference.score = d;
  safe.pillars.ease.score       = e;

  // overallScore = sum of clamped pillars (deterministic)
  safe.overallScore = c + t + d + e;

  const marketTier = safe.marketPosition.tier;
  const isDominant = DOMINANT_TIERS.includes(marketTier);

  // ── VERDICT OVERRIDE ───────────────────────────────────────────────────────
  //
  // Two separate dimensions:
  //   1. AI RECOMMENDATION LIKELIHOOD — will AI actually recommend this business?
  //      Driven by market position, brand recognition, and real-world selection frequency.
  //      Dominant/strong brands ARE recommended regardless of schema gaps.
  //
  //   2. AI READABILITY SCORE — how optimised is the business for AI?
  //      Driven by schema, structured data, llms.txt, citations.
  //      This is what the pillar scores measure.
  //
  // The verdictLevel reflects recommendation likelihood (dimension 1).
  // The score and actions reflect readability gaps (dimension 2).
  // These are intentionally separate — a dominant brand can score 54 on readability
  // but still be "present" in recommendation likelihood.

  if (isDominant) {
    // Dominant/strong brands: AI will recommend them — verdict is always present
    // Score still reflects infrastructure gaps — this is the CHOIVE opportunity:
    // even dominant brands are vulnerable without proper AI-readability signals
    safe.verdictLevel    = 'present';
    safe.verdictHeadline = 'Chosen by default — but infrastructure is exposed';
  } else if (safe.overallScore <= 30) {
    safe.verdictLevel    = 'absent';
    safe.verdictHeadline = 'Not the obvious choice — losing decisions';
  } else if (
    safe.overallScore <= 55 ||
    e < 12 ||
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
