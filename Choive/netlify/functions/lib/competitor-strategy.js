'use strict';

// competitor-strategy.js
// A "how to win against the businesses AI names instead of you" section for the
// premium report.
//
// STRICT HONESTY: this module invents NOTHING about competitors. It only uses
// facts CHOIVE already recorded during the run:
//   - result.displacement — the business an AI actually named instead (with the
//     recorded reason the AI gave).
//   - result.competitors — real domains that surfaced in search comparisons.
//   - result.pillars — the business's own weak spots (real scores + findings).
// If a fact was never collected, it is omitted. No made-up strengths, ratings,
// prices, or claims about any competitor.

var PILLAR_LABEL = {
  clarity: 'Being clear',
  trust: 'Being trusted',
  difference: 'Being different',
  ease: 'Being easy to choose'
};
var PILLAR_ORDER = ['clarity', 'trust', 'difference', 'ease'];

// Plain-language "what to do" tied to the owner's OWN weakest pillar. This is
// advice about the business's own gap, not a claim about the competitor.
var WIN_MOVE = {
  clarity: 'Say in one plain sentence what you do and who it is for, on your homepage, so AI can repeat it.',
  trust: 'Get a few more real, recent reviews and show them, so AI sees other people trust you.',
  difference: 'Say the one thing you do that the others do not, in plain words, in an obvious place.',
  ease: 'Make it dead simple to contact you and buy, with clear next steps AI can point people to.'
};

function clean(s, max) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trim() + '…';
  return t;
}

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

// The owner's two weakest measured pillars, worst first. These are the real
// places a competitor is likely beating them.
function weakestPillars(pillars) {
  var rows = PILLAR_ORDER
    .map(function (p) {
      var obj = pillars && pillars[p];
      if (!obj || typeof obj.score !== 'number' || !isFinite(obj.score)) return null;
      return { pillar: p, score: num(obj.score), finding: clean(obj.finding || '', 220) };
    })
    .filter(Boolean)
    .sort(function (a, b) { return a.score - b.score; });
  return rows.slice(0, 2);
}

/**
 * buildCompetitorStrategy(result) -> {
 *   available: boolean,
 *   namedByAI: { name, why } | null,     // the competitor an AI named instead
 *   alsoSeen: [ { domain, note } ],      // real domains from search (deduped)
 *   winMoves: [ { pillar, pillarLabel, currentScore, observed, move } ],
 *   summary: string
 * }
 */
function buildCompetitorStrategy(result) {
  var r = result && typeof result === 'object' ? result : {};
  var d = r.displacement && typeof r.displacement === 'object' ? r.displacement : {};

  var namedByAI = null;
  if (d.competitorName && clean(d.competitorName)) {
    namedByAI = {
      name: clean(d.competitorName, 80),
      // Only include the recorded reason — never invent one.
      why: clean(d.competitorWhy || '', 280),
      query: clean(d.competitorQuery || '', 160)
    };
  }

  // Real search-surfaced competitors, minus the one already named, deduped by
  // domain. We only show the domain and (if present) its recorded snippet.
  var seen = {};
  if (namedByAI && namedByAI.name) seen[namedByAI.name.toLowerCase().replace(/\s+/g, '')] = true;
  var alsoSeen = [];
  (Array.isArray(r.competitors) ? r.competitors : []).forEach(function (c) {
    if (!c) return;
    var domain = clean(c.domain || '', 60);
    if (!domain) return;
    var key = domain.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    alsoSeen.push({ domain: domain, note: clean(c.title || c.snippet || '', 160) });
  });
  alsoSeen = alsoSeen.slice(0, 5);

  var weak = weakestPillars(r.pillars);
  var winMoves = weak.map(function (w) {
    return {
      pillar: w.pillar,
      pillarLabel: PILLAR_LABEL[w.pillar],
      currentScore: w.score,
      observed: w.finding,
      move: WIN_MOVE[w.pillar]
    };
  });

  var available = !!(namedByAI || alsoSeen.length || winMoves.length);

  var summary;
  if (namedByAI) {
    summary = 'When we asked AI about your kind of business, it often named ' + namedByAI.name + ' instead of you. The good news: the gaps that let them win are gaps you can close. Below is exactly where to start.';
  } else if (alsoSeen.length) {
    summary = 'These are the businesses showing up in the same searches as you. Below is where to focus so AI names you, not just them.';
  } else if (winMoves.length) {
    summary = 'We could not pin down one clear rival, but your weakest areas below are where rivals usually get ahead. Fix these first.';
  } else {
    summary = '';
  }

  return {
    available: available,
    namedByAI: namedByAI,
    alsoSeen: alsoSeen,
    winMoves: winMoves,
    summary: summary
  };
}

module.exports = { buildCompetitorStrategy: buildCompetitorStrategy, PILLAR_LABEL: PILLAR_LABEL };
