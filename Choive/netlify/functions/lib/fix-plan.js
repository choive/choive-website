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
  'DI-01': 'Write one clear sentence that says what you do that other businesses in your space do not. Put it near the top of your homepage and on its own "What makes us different" page, in plain words a first-time visitor understands.',
  'DI-03': 'Say plainly which niche or type of customer you focus on best. Add it to your homepage and your "What makes us different" page so both people and AI can see the exact space you own.',
  'DI-04': 'Show one real, checkable result you have delivered — a number, a before-and-after, or a named outcome. Put it on your "What makes us different" page as proof, not just a claim.',
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
function matchAction(actions, pillar, ruleLabel) {
  if (!Array.isArray(actions) || !actions.length) return null;
  var needlePillar = pillar.toLowerCase();
  var needleLabel = String(ruleLabel || '').toLowerCase();
  var best = null;
  var bestScore = -1;
  actions.forEach(function (a) {
    if (!a || typeof a !== 'object') return;
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
  return bestScore >= 1 ? best : null;
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
function fixesFromAudits(pillar, rules, actions) {
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
    var action = matchAction(actions, pillar, label);
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
function fixFromPillarGap(pillar, pillarObj, signalRows, actions) {
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
  var action = matchAction(actions, pillar, missing.join(' '));
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

// Rank: biggest point impact first; on ties, quick self-serve wins come first
// (fast points), then by pillar order for stability.
function rankFixes(fixes) {
  var pillarOrder = { clarity: 0, ease: 1, difference: 2, trust: 3 };
  return fixes.slice().sort(function (a, b) {
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
  PILLARS.forEach(function (pillar) {
    var ledgerRules = audits && Array.isArray(audits[pillar]) ? audits[pillar] : null;
    var fromLedger = ledgerRules ? fixesFromAudits(pillar, ledgerRules, actions) : [];
    if (fromLedger.length) {
      fixes = fixes.concat(fromLedger);
    } else {
      var gapFix = fixFromPillarGap(pillar, pillars[pillar], signalAudit[pillar], actions);
      if (gapFix) fixes.push(gapFix);
    }
  });

  fixes = rankFixes(fixes);
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
