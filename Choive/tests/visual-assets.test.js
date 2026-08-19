'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildVisualAssets, scoreColor, scoreWord } = require('../netlify/functions/lib/visual-assets');

function fullResult(score) {
  return {
    overallScore: score,
    pillars: { clarity: { score: 20 }, trust: { score: 12 }, difference: { score: 22 }, ease: { score: 14 } }
  };
}

test('visual: unavailable when there is no overall score', () => {
  assert.strictEqual(buildVisualAssets({}, {}).available, false);
  assert.strictEqual(buildVisualAssets({ overallScore: 'x' }, {}).available, false);
  assert.strictEqual(buildVisualAssets(null, null).available, false);
});

test('visual: builds all three assets when score + 4 pillars exist', () => {
  const a = buildVisualAssets(fullResult(68), { name: 'Acme Co' });
  assert.strictEqual(a.available, true);
  assert.strictEqual(a.score, 68);
  assert.ok(a.scoreDial.startsWith('<svg'));
  assert.ok(a.pillarBars.startsWith('<svg'));
  assert.ok(a.scoreCard.startsWith('<svg'));
});

test('visual: pillar assets omitted when pillars are incomplete', () => {
  const a = buildVisualAssets({ overallScore: 50, pillars: { clarity: { score: 10 } } }, { name: 'X' });
  assert.strictEqual(a.available, true);
  assert.ok(a.scoreDial.startsWith('<svg'), 'dial always available with a score');
  assert.strictEqual(a.pillarBars, null);
  assert.strictEqual(a.scoreCard, null);
});

test('visual: the drawn score is the real score, not invented', () => {
  const a = buildVisualAssets(fullResult(43), { name: 'X' });
  assert.ok(a.scoreDial.indexOf('>43<') !== -1, 'dial shows the real score');
  assert.ok(a.scoreCard.indexOf('>43<') !== -1, 'card shows the real score');
});

test('visual: pillar values shown are the real pillar scores out of 25', () => {
  const a = buildVisualAssets(fullResult(68), { name: 'X' });
  ['20/25', '12/25', '22/25', '14/25'].forEach(function (frag) {
    assert.ok(a.pillarBars.indexOf(frag) !== -1, 'bars show ' + frag);
    assert.ok(a.scoreCard.indexOf(frag) !== -1, 'card shows ' + frag);
  });
});

test('visual: business name is XML-escaped', () => {
  const a = buildVisualAssets(fullResult(60), { name: 'Bright & <Co>' });
  assert.ok(a.scoreCard.indexOf('Bright &amp; &lt;Co&gt;') !== -1, 'name escaped in card');
  assert.ok(a.scoreCard.indexOf('Bright & <Co>') === -1, 'raw name not present');
});

test('visual: score clamps to 0-100', () => {
  assert.strictEqual(buildVisualAssets(fullResult(140), {}).score, 100);
  assert.strictEqual(buildVisualAssets(fullResult(-5), {}).score, 0);
});

test('visual: score band matches the report bands', () => {
  assert.strictEqual(scoreColor(80), '#4A9965');
  assert.strictEqual(scoreColor(60), '#9A6A14');
  assert.strictEqual(scoreColor(30), '#B13D3D');
  assert.strictEqual(scoreWord(80), 'Strong');
  assert.strictEqual(scoreWord(60), 'Building');
  assert.strictEqual(scoreWord(30), 'At risk');
});

test('visual: SVGs carry the CHOIVE brand and tagline', () => {
  const a = buildVisualAssets(fullResult(68), { name: 'X' });
  assert.ok(a.scoreCard.indexOf('CHOIVE') !== -1);
  assert.ok(a.scoreCard.indexOf('Be the answer. Not the alternative.') !== -1);
  assert.ok(a.scoreCard.indexOf('choive.com') !== -1);
});

test('visual: falls back to businessUnderstanding.name when input has none', () => {
  const r = fullResult(60);
  r.businessUnderstanding = { name: 'Fallback Biz' };
  const a = buildVisualAssets(r, {});
  assert.ok(a.scoreCard.indexOf('Fallback Biz') !== -1);
});

test('visual: never promises the score will rise', () => {
  const a = buildVisualAssets(fullResult(68), { name: 'X' });
  const blob = (a.scoreDial + a.pillarBars + a.scoreCard).toLowerCase();
  assert.ok(!/\bguarantee\b|will increase|will improve your score/.test(blob));
});

// ── Certificate tests ───────────────────────────────────────────────────────
test('cert: built whenever a score exists (even without full pillars)', () => {
  const a = buildVisualAssets({ overallScore: 50, pillars: { clarity: { score: 10 } } }, { name: 'X' });
  assert.ok(a.certificate && a.certificate.startsWith('<svg'), 'certificate needs only a score');
});

test('cert: unavailable when there is no score', () => {
  assert.strictEqual(buildVisualAssets({}, {}).certificate, null);
});

test('cert: shows the real score, band word and business name', () => {
  const a = buildVisualAssets(fullResult(68), { name: 'Bright & Co Cafe' });
  assert.ok(a.certificate.indexOf('>68<') !== -1, 'certificate shows the real score');
  assert.ok(a.certificate.indexOf('BUILDING') !== -1, 'certificate shows the score band word');
  assert.ok(a.certificate.indexOf('Bright &amp; Co Cafe') !== -1, 'business name is XML-escaped');
});

test('cert: carries the founder signature and title', () => {
  const a = buildVisualAssets(fullResult(80), { name: 'X' });
  assert.ok(a.certificate.indexOf('Blessing Ashionye Ebogu') !== -1, 'founder signature present');
  assert.ok(a.certificate.indexOf('Founder, CHOIVE') !== -1, 'founder title present');
});

test('cert: embeds a real signature image when one is supplied', () => {
  const dataUri = 'data:image/png;base64,AAAA';
  const a = buildVisualAssets(fullResult(72), { name: 'X' }, { signatureDataUri: dataUri });
  assert.ok(a.certificate.indexOf('<image') !== -1, 'uses an image element for a real signature');
  assert.ok(a.certificate.indexOf(dataUri) !== -1, 'embeds the supplied signature data URI');
});

test('cert: never promises a higher score or makes ranking claims', () => {
  const svg = buildVisualAssets(fullResult(90), { name: 'X' }).certificate.toLowerCase();
  assert.ok(!/best|no\.?\s*1|number one|top rated|guarantee|will (increase|improve|rise)/.test(svg),
    'certificate must not make ranking or promise claims');
});

test('cert: uses a real issued date when supplied', () => {
  const a = buildVisualAssets(fullResult(60), { name: 'X' }, { issuedDate: '2026-08-19T00:00:00Z' });
  assert.ok(a.certificate.indexOf('19 August 2026') !== -1, 'shows the supplied issue date');
});
