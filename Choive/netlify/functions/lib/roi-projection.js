'use strict';

// roi-projection.js
// An HONEST, input-driven value model for the premium report.
//
// CHOIVE measures how often AI assistants recommend a business. It cannot see a
// business's real sales and must NEVER invent revenue, customer counts, or
// "you will earn £X" promises. So this module does NOT predict money. Instead it
// gives the owner a clear what-if framework they fill in with THEIR OWN numbers:
//
//   extra money a month  =  (extra customers a month)  ×  (what one customer is worth)
//
// We supply three clearly-labelled example scenarios (small / medium / big) for
// "extra customers a month", scaled off how much score the business can still
// win back. Every scenario is stamped as an example, not a promise. If the owner
// types nothing, no number is shown as fact.
//
// Nothing here changes the score. It only reads it.

function clampNum(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function round(n) { return Math.round(clampNum(n)); }

// The three example lift levels. These describe how much MORE OFTEN an AI might
// name the business once its gaps are closed — NOT a revenue multiplier and NOT
// a guarantee. They are deliberately modest and always shown as "example".
var SCENARIOS = [
  { key: 'small',  label: 'A small change',  extraCustomersHint: 1 },
  { key: 'medium', label: 'A medium change', extraCustomersHint: 3 },
  { key: 'big',    label: 'A big change',    extraCustomersHint: 6 }
];

/**
 * buildRoiModel(result) -> {
 *   available: boolean,
 *   currentScore, headroom,
 *   scenarios: [ { key, label, exampleExtraCustomers, note } ],
 *   inputs: [ { id, label, help, placeholder } ],
 *   formula: string,          // plain-language formula the calculator uses
 *   howItWorks: string,       // one plain paragraph
 *   disclaimer: string        // the honesty guardrail, always shown
 * }
 *
 * The frontend calculator does the arithmetic with the owner's typed numbers.
 * This module only sets up the honest framework and the example figures.
 */
function buildRoiModel(result) {
  var r = result && typeof result === 'object' ? result : {};
  var score = round(r.overallScore);
  if (!(score > 0)) {
    // No real score means no honest basis for a what-if. Say so plainly.
    return {
      available: false,
      reason: 'We need a finished score before we can show a value example.'
    };
  }
  var headroom = Math.max(0, 100 - score);

  // Scale the example "extra customers" gently by how much room there is to
  // improve. A business already near 100 has little to gain, so its examples
  // stay small. This only touches the EXAMPLE numbers, never a real figure.
  var factor = headroom >= 40 ? 1 : (headroom >= 20 ? 0.66 : 0.5);
  var scenarios = SCENARIOS.map(function (s) {
    var n = Math.max(1, round(s.extraCustomersHint * factor));
    return {
      key: s.key,
      label: s.label,
      exampleExtraCustomers: n,
      note: 'Example only: ' + n + ' more customer' + (n === 1 ? '' : 's') + ' a month. Change this to your own guess.'
    };
  });

  return {
    available: true,
    currentScore: score,
    headroom: headroom,
    inputs: [
      { id: 'roiValue', label: 'What is one new customer worth to you?', help: 'A rough amount of money you make from one customer. Use your own number.', placeholder: 'e.g. 200' },
      { id: 'roiCustomers', label: 'How many more customers a month feels possible?', help: 'Your own honest guess. Start with one of the examples below and change it.', placeholder: 'e.g. 3' }
    ],
    scenarios: scenarios,
    formula: 'Extra money a month = (more customers a month) × (what one customer is worth)',
    howItWorks: 'Right now AI assistants do not name you as often as they could. You have ' + headroom + ' points still to win. When you close your gaps, AI can name you more often, and more people can find you. Type your own numbers below to see what even a few more customers a month could be worth to you.',
    disclaimer: 'These are what-if examples, not promises. CHOIVE measures how AI talks about you — it cannot promise sales. Every number here uses only what YOU type.'
  };
}

module.exports = { buildRoiModel: buildRoiModel };
