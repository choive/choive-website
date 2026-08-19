'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildVisualAssets, scoreColor, scoreWord, verifyUrl } = require('../netlify/functions/lib/visual-assets');

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

test('cert: carries an embossed gold-foil verification seal', () => {
  const a = buildVisualAssets(fullResult(72), { name: 'X' });
  assert.ok(a.certificate.indexOf('certFoil') !== -1, 'certificate defines the foil gradient');
  assert.ok(a.certificate.indexOf('url(#certFoil)') !== -1, 'seal is filled with the foil gradient');
  assert.ok(a.certificate.indexOf('VERIFIED') !== -1, 'seal reads VERIFIED');
});

// ── Seal (embossed medallion) tests ─────────────────────────────────────────
test('seal: is an embossed gold-foil medallion (metallic gradient + beaded edge)', () => {
  const a = buildVisualAssets(fullResult(82), { name: 'Bright Smile Dental' }, { jobId: 'Z' });
  assert.ok(a.seal.indexOf('radialGradient') !== -1, 'seal uses a metallic radial gradient for foil sheen');
  const beads = (a.seal.match(/<circle/g) || []).length;
  assert.ok(beads > 40, 'seal has a beaded foil edge (many circles), got ' + beads);
  assert.ok(/VERIFIED\s+AI\s+VISIBILITY/.test(a.seal), 'seal carries the verified wording');
  assert.ok(a.seal.indexOf('Bright Smile Dental') !== -1, 'seal names the business');
});

// ── Verified Kit tests ──────────────────────────────────────────────────────
test('kit: verifyUrl builds a /verify link with the job id', () => {
  assert.strictEqual(verifyUrl({ origin: 'https://choive.com', jobId: '8F3K2A' }), 'https://choive.com/verify?j=8F3K2A');
  assert.strictEqual(verifyUrl({}), 'https://choive.com/verify');
  assert.strictEqual(verifyUrl({ verifyUrl: 'https://x.test/v?j=1' }), 'https://x.test/v?j=1');
  // origin trailing slashes are trimmed
  assert.strictEqual(verifyUrl({ origin: 'https://choive.com/', jobId: 'A' }), 'https://choive.com/verify?j=A');
});

test('kit: all kit marks are built when a score + 4 pillars exist', () => {
  const a = buildVisualAssets(fullResult(82), { name: 'Bright & Co' }, { origin: 'https://choive.com', jobId: '8F3K2A' });
  ['certificate', 'seal', 'card', 'story', 'chipLight', 'chipDark'].forEach(function (k) {
    assert.ok(a[k] && a[k].startsWith('<svg'), k + ' should be an svg');
  });
  assert.strictEqual(a.verifyUrl, 'https://choive.com/verify?j=8F3K2A');
});

test('kit: dial-only marks still render without full pillars (card needs pillars)', () => {
  const a = buildVisualAssets({ overallScore: 60, pillars: { clarity: { score: 10 } } }, { name: 'X' });
  assert.ok(a.seal.startsWith('<svg'), 'seal needs only a score');
  assert.ok(a.story.startsWith('<svg'), 'story needs only a score');
  assert.ok(a.chipLight.startsWith('<svg') && a.chipDark.startsWith('<svg'), 'chips need only a score');
  assert.ok(a.certificate.startsWith('<svg'), 'certificate needs only a score');
  assert.strictEqual(a.card, null, 'square social card needs 4 pillars');
});

test('kit: every QR-bearing mark carries a real QR (many module rects)', () => {
  const a = buildVisualAssets(fullResult(82), { name: 'X' }, { origin: 'https://choive.com', jobId: '8F3K2A' });
  ['certificate', 'card', 'story'].forEach(function (k) {
    const rects = (a[k].match(/<rect/g) || []).length;
    assert.ok(rects > 80, k + ' should embed a QR made of many rects, got ' + rects);
    assert.ok(a[k].indexOf('Scan to verify') !== -1, k + ' invites a scan');
  });
});

test('kit: the real score appears on each kit mark', () => {
  const a = buildVisualAssets(fullResult(47), { name: 'X' }, { origin: 'https://choive.com', jobId: 'Z' });
  ['certificate', 'seal', 'card', 'story', 'chipLight', 'chipDark'].forEach(function (k) {
    assert.ok(a[k].indexOf('>47<') !== -1, k + ' shows the real score');
  });
});

test('kit: business name is XML-escaped on every kit mark', () => {
  const a = buildVisualAssets(fullResult(60), { name: 'Bright & <Co>' }, { jobId: 'Z' });
  ['certificate', 'seal', 'card', 'story', 'chipLight', 'chipDark'].forEach(function (k) {
    assert.ok(a[k].indexOf('Bright &amp; &lt;Co&gt;') !== -1, k + ' escapes the name');
    assert.ok(a[k].indexOf('Bright & <Co>') === -1, k + ' has no raw name');
  });
});

test('kit: no kit mark makes a ranking or promise claim', () => {
  const a = buildVisualAssets(fullResult(90), { name: 'X' }, { jobId: 'Z' });
  const blob = ['certificate', 'seal', 'card', 'story', 'chipLight', 'chipDark']
    .map(function (k) { return a[k]; }).join(' ').toLowerCase();
  assert.ok(!/\bbest\b|no\.?\s*1|number one|top rated|guarantee|will (increase|improve|rise)/.test(blob),
    'kit marks must not make ranking or promise claims');
});

test('kit: chips come in a light and a dark variant', () => {
  const a = buildVisualAssets(fullResult(82), { name: 'X' }, { jobId: 'Z' });
  assert.ok(a.chipLight.indexOf('#F5F2EE') !== -1, 'light chip uses the paper background');
  assert.ok(a.chipDark.indexOf('#0C0C0E') !== -1, 'dark chip uses the void background');
});
