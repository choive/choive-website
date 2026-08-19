'use strict';

// lib/fix-plan.js
// CHOIVE™ — Priority Fix Plan
//
// Turns a completed diagnostic result into a prioritised, specific fix list
// where every item carries an *estimated point impact* derived from the real
// deterministic scoring ledger — not a guess.
//
// The honest basis: each pillar is scored 0–25 by a set of audit rules stored
// in result.scoreMethod.audits[pillar] as { ruleId, label, points, maxPoints,
// verification, observed, source }. The recoverable points for a rule is
// exactly (maxPoints - points). We surface those gaps, rank them, and attach
// the concrete "how to fix + how to verify" language from result.actions where
// it maps cleanly. When the audit ledger is absent we fall back to the pillar
// gap (25 - score) so the plan still renders on older results.
//
// Pure, dependency-free, and safe against partial/missing fields so it can run
// server-side (get-result) and be unit-tested with `node --test`.
//
// Business-type awareness: when the result carries an archetype profile (see
// lib/business-archetype.js), the fix list is ORDERED so the fixes that matter
// most for THAT kind of business come first (e.g. reviews for a local shop,
// clarity for a software company). The point impact of each fix is never
// changed — only the order — so the honest 0-100 score stays intact.

var { getArchetypeProfile } = require('./business-archetype');

var PILLARS = ['clarity', 'trust', 'difference', 'ease'];

var PILLAR_LABEL = {
  clarity: 'Clarity',
  trust: 'Trust',
  difference: 'Difference',
  ease: 'Ease'
};

// From the engine's own model (index.html evidence-gap logic): Clarity and Ease
// are things you control on your own site; Trust and Difference generally need
// independently verifiable, external proof (reviews, press, third-party pages).
var CLOSABILITY = {
  clarity: 'self-serve',
  ease: 'self-serve',
  difference: 'external-evidence',
  trust: 'external-evidence'
};

var EFFORT = {
  'self-serve': 'Easy — a change you can make on your own website.',
  'external-evidence': 'Harder — you need proof on other websites (like reviews, news stories, or listings).'
};

// Difference is scored on your own website copy, so most of its checks are
// self-serve: you write, in plain words, what makes you different and put it on
// a page. Only a named client/partner needs someone outside to confirm it.
// Trust's checks stay external because they depend on reviews and press.
var RULE_CLOSABILITY = {
  'DI-01': 'self-serve',
  'DI-03': 'self-serve',
  'DI-04': 'self-serve',
  'DI-02': 'external-evidence'
};

// Concrete, plain-language fix used when the model did not author a matching
// action. These tell the owner exactly what to write and where to put it —
// including a dedicated "What makes us different" page — instead of a generic
// "improve your differentiation" line.
var DEFAULT_HOW = {
  'DI-01': 'Write one clear sentence that says what you do that other businesses in your space do not. Put it near the top of your homepage, on its own "What makes us different" page, and in your social media bios — in plain words a first-time visitor understands. Then make a few short posts that teach people why this makes you the better choice.',
  'DI-03': 'Say plainly which niche or type of customer you focus on best, and why people should pick you over others. Add it to your homepage and your "What makes us different" page, and repeat it in your social media so both people and AI can see the exact space you own.',
  'DI-04': 'Show one real, checkable result you have delivered — a number, a before-and-after, or a named outcome. Put it on your "What makes us different" page and share it as a post, so people and AI can see the proof, not just a claim.',
  'DI-02': 'Name a real client or partner you have worked with (with their permission) and link to something that confirms it. A named, checkable client is far stronger proof than "trusted by many".'
};

function num(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function round(v) {
  return Math.round(num(v));
}

function clean(str, max) {
  var t = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  if (max && t.length > max) {
    t = t.slice(0, max).replace(/[\s,.;:-]+$/, '') + '…';
  }
  return t;
}

// Rank the model's action priority so we can pick the best action to attach.
var PRIORITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// Try to find the model-authored action that best matches a fix. We match on
// pillar keyword presence in the action text, falling back to priority order.
//
// `used` (optional array) collects the actions already attached to earlier
// cards so the SAME action is never reused on two different cards. Without this
// a review-heavy action (which mentions both "reviews" and "category rivals")
// could attach to BOTH the Trust card AND the Difference card, printing
// identical "What to do" text on two cards about different things. Pillars are
// processed in a fixed order (clarity, trust, difference, ease), so the pillar
// an action fits best claims it first and later pillars fall back to their own
// concrete DEFAULT_HOW copy.
function matchAction(actions, pillar, ruleLabel, used) {
  if (!Array.isArray(actions) || !actions.length) return null;
  used = Array.isArray(used) ? used : [];
  var needlePillar = pillar.toLowerCase();
  var needleLabel = String(ruleLabel || '').toLowerCase();
  var best = null;
  var bestScore = -1;
  actions.forEach(function (a) {
    if (!a || typeof a !== 'object') return;
    if (used.indexOf(a) !== -1) return; // already used on another card
    var hay = (String(a.title || '') + ' ' + String(a.body || '') + ' ' +
      String(a.explanation || '')).toLowerCase();
    var score = 0;
    if (needlePillar && hay.indexOf(needlePillar) !== -1) score += 3;
    // keyword overlap with the rule label
    needleLabel.split(/[^a-z0-9]+/).forEach(function (w) {
      if (w.length >= 5 && hay.indexOf(w) !== -1) score += 1;
    });
    score += (PRIORITY_RANK[String(a.priority || '').toLowerCase()] || 0) * 0.1;
    if (score > bestScore) { bestScore = score; best = a; }
  });
  // Only attach if there is a real signal of relevance, not just priority.
  // De-duplication (via `used`) is what stops the mislabelled-card bug: the
  // pillar an action fits best is processed first and claims it, so a later
  // pillar can no longer print the same action's text — it falls back to its own
  // concrete DEFAULT_HOW copy instead.
  if (bestScore >= 1 && best) { used.push(best); return best; }
  return null;
}

function actionFields(action) {
  if (!action) return { how: '', verify: '', ifNothing: '' };
  return {
    how: clean(action.body || action.title || '', 400),
    verify: clean(action.verification || '', 240),
    ifNothing: clean(action.if_nothing || '', 240)
  };
}

// Build fixes from the deterministic audit ledger for one pillar.
// `used` accumulates model actions already attached to earlier cards so none is
// reused across two cards (see matchAction).
function fixesFromAudits(pillar, rules, actions, used) {
  var out = [];
  (Array.isArray(rules) ? rules : []).forEach(function (rule) {
    if (!rule || typeof rule !== 'object') return;
    var verification = String(rule.verification || '').toLowerCase();
    // A check that did not run never lowered the score, so it is not a fix.
    if (verification === 'unmeasured') return;
    var max = num(rule.maxPoints);
    var got = num(rule.points);
    var gap = max - got;
    if (!(gap > 0)) return; // already at full credit for this rule
    var label = clean(rule.label || rule.ruleId || 'Missing proof', 120);
    var action = matchAction(actions, pillar, label, used);
    var af = actionFields(action);
    var closability = RULE_CLOSABILITY[rule.ruleId] || CLOSABILITY[pillar];
    out.push({
      id: String(rule.ruleId || (pillar + '-' + label)).slice(0, 80),
      pillar: pillar,
      pillarLabel: PILLAR_LABEL[pillar],
      title: label,
      observed: clean(rule.observed || '', 300),
      pointImpact: round(gap),
      maxPoints: round(max),
      currentPoints: round(got),
      closability: closability,
      effort: EFFORT[closability],
      verificationType: verification,
      how: af.how || DEFAULT_HOW[rule.ruleId] || '',
      verify: af.verify,
      ifNothing: af.ifNothing,
      basis: 'ledger'
    });
  });
  return out;
}

// Fallback when the audit ledger is missing: one fix per pillar that lost
// points, using the pillar gap and the failed signal-audit checks as detail.
function fixFromPillarGap(pillar, pillarObj, signalRows, actions, used) {
  // Only build a fallback fix when the pillar was actually measured. An absent
  // pillar (no object / no numeric score) is missing data, not a 25-point gap,
  // and must never be fabricated into a fix.
  if (!pillarObj || typeof pillarObj !== 'object' || typeof pillarObj.score !== 'number' || !isFinite(pillarObj.score)) {
    return null;
  }
  var score = num(pillarObj.score);
  var gap = 25 - score;
  if (!(gap > 0)) return null;
  var fails = (Array.isArray(signalRows) ? signalRows : []).filter(function (s) {
    var st = String(s && s.status || '').toLowerCase();
    return st === 'fail' || st === 'partial';
  });
  var missing = fails.map(function (s) { return clean(s.name || '', 60); }).filter(Boolean);
  var title = missing.length
    ? 'Close the ' + PILLAR_LABEL[pillar] + ' gap: ' + missing.slice(0, 3).join(', ')
    : 'Raise your ' + PILLAR_LABEL[pillar] + ' score';
  var action = matchAction(actions, pillar, missing.join(' '), used);
  var af = actionFields(action);
  var observed = fails.length
    ? fails.slice(0, 3).map(function (s) { return clean(s.name + ': ' + (s.detail || ''), 120); }).join(' · ')
    : clean(pillarObj && pillarObj.finding || '', 300);
  return {
    id: pillar + '-gap',
    pillar: pillar,
    pillarLabel: PILLAR_LABEL[pillar],
    title: clean(title, 120),
    observed: observed,
    pointImpact: round(gap),
    maxPoints: 25,
    currentPoints: round(score),
    closability: CLOSABILITY[pillar],
    effort: EFFORT[CLOSABILITY[pillar]],
    verificationType: '',
    how: af.how,
    verify: af.verify,
    ifNothing: af.ifNothing,
    basis: 'pillar-gap'
  };
}

// Rank: biggest WEIGHTED point impact first; on ties, quick self-serve wins
// come first (fast points), then by pillar order for stability.
//
// emphasis is an optional { clarity, trust, difference, ease } map of 1–3
// weights from the business's archetype profile. A fix's sort key is
// pointImpact × pillar weight, so the fixes that matter most for THIS type of
// business rise to the top. When no emphasis is supplied every weight is 1, so
// behaviour is identical to plain "biggest impact first". The pointImpact value
// shown to the owner is never altered — only the order.
function rankFixes(fixes, emphasis) {
  var pillarOrder = { clarity: 0, ease: 1, difference: 2, trust: 3 };
  var w = function (pillar) {
    var v = emphasis && emphasis[pillar];
    return typeof v === 'number' && v > 0 ? v : 1;
  };
  return fixes.slice().sort(function (a, b) {
    var aKey = a.pointImpact * w(a.pillar);
    var bKey = b.pointImpact * w(b.pillar);
    if (bKey !== aKey) return bKey - aKey;
    if (b.pointImpact !== a.pointImpact) return b.pointImpact - a.pointImpact;
    var ac = a.closability === 'self-serve' ? 0 : 1;
    var bc = b.closability === 'self-serve' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return (pillarOrder[a.pillar] || 0) - (pillarOrder[b.pillar] || 0);
  });
}

/**
 * buildFixPlan(result) -> {
 *   available: boolean,
 *   overallScore, headroom,
 *   fixes: [ { id, pillar, pillarLabel, title, observed, pointImpact,
 *              maxPoints, currentPoints, closability, effort,
 *              verificationType, how, verify, ifNothing, basis, rank } ],
 *   summary: { totalRecoverable, quickWinPoints, quickWinCount,
 *              topPillar, topPillarLabel, fixCount }
 * }
 */
function buildFixPlan(result) {
  var r = result && typeof result === 'object' ? result : {};
  var pillars = r.pillars && typeof r.pillars === 'object' ? r.pillars : {};
  var audits = r.scoreMethod && r.scoreMethod.audits && typeof r.scoreMethod.audits === 'object'
    ? r.scoreMethod.audits : null;
  var signalAudit = r.signalAudit && typeof r.signalAudit === 'object' ? r.signalAudit : {};
  var actions = Array.isArray(r.actions) ? r.actions : [];

  var fixes = [];
  // Shared across every pillar so one model action is attached to at most one
  // card. Pillars run in a fixed order (clarity, trust, difference, ease); the
  // pillar an action fits best claims it first, so e.g. a review action lands on
  // Trust and the Difference card falls back to its own "what makes you
  // different" copy instead of repeating the same text.
  var used = [];
  PILLARS.forEach(function (pillar) {
    var ledgerRules = audits && Array.isArray(audits[pillar]) ? audits[pillar] : null;
    var fromLedger = ledgerRules ? fixesFromAudits(pillar, ledgerRules, actions, used) : [];
    if (fromLedger.length) {
      fixes = fixes.concat(fromLedger);
    } else {
      var gapFix = fixFromPillarGap(pillar, pillars[pillar], signalAudit[pillar], actions, used);
      if (gapFix) fixes.push(gapFix);
    }
  });

  // Business-type awareness: order the fixes by what matters most for THIS
  // kind of business. Prefer an archetype profile already attached to the
  // result; fall back to looking it up from result.archetype; else no emphasis.
  var profile = null;
  if (r.archetypeProfile && r.archetypeProfile.pillarEmphasis) {
    profile = r.archetypeProfile;
  } else if (r.archetype) {
    try { profile = getArchetypeProfile(r.archetype); } catch (e) { profile = null; }
  }
  var emphasis = profile && profile.pillarEmphasis ? profile.pillarEmphasis : null;

  fixes = rankFixes(fixes, emphasis);
  fixes.forEach(function (f, i) { f.rank = i + 1; });

  var totalRecoverable = fixes.reduce(function (acc, f) { return acc + f.pointImpact; }, 0);
  var quickWins = fixes.filter(function (f) { return f.closability === 'self-serve'; });
  var quickWinPoints = quickWins.reduce(function (acc, f) { return acc + f.pointImpact; }, 0);

  // Top pillar by aggregate recoverable points.
  var byPillar = {};
  fixes.forEach(function (f) { byPillar[f.pillar] = (byPillar[f.pillar] || 0) + f.pointImpact; });
  var topPillar = null; var topVal = -1;
  PILLARS.forEach(function (p) { if ((byPillar[p] || 0) > topVal) { topVal = byPillar[p] || 0; topPillar = p; } });

  var overallScore = round(r.overallScore != null ? r.overallScore
    : PILLARS.reduce(function (acc, p) { return acc + num(pillars[p] && pillars[p].score); }, 0));

  return {
    available: fixes.length > 0,
    overallScore: overallScore,
    headroom: Math.max(0, 100 - overallScore),
    // Plain-language note explaining what we weighted most for a business like
    // this one. null when the result has no archetype (older results).
    archetypeEmphasis: profile ? {
      archetype: r.archetype || null,
      label: profile.label,
      note: profile.emphasisNote
    } : null,
    fixes: fixes,
    summary: {
      totalRecoverable: round(totalRecoverable),
      quickWinPoints: round(quickWinPoints),
      quickWinCount: quickWins.length,
      topPillar: topVal > 0 ? topPillar : null,
      topPillarLabel: topVal > 0 ? PILLAR_LABEL[topPillar] : '',
      fixCount: fixes.length
    }
  };
}

module.exports = { buildFixPlan: buildFixPlan, PILLAR_LABEL: PILLAR_LABEL, CLOSABILITY: CLOSABILITY };
