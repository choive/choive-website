// visual-assets.js
// CHOIVE™ — branded SVG visual assets built ONLY from real recorded scores.
//
// Every number drawn here comes straight from the diagnostic result:
//   - result.overallScore (0-100)
//   - result.pillars.{clarity,trust,difference,ease}.score (0-25 each)
//   - the business name (from input)
// Nothing is invented. If the score is missing the asset reports available:false
// and the report simply does not offer graphics. These are standalone SVG files
// the owner can download and reuse, so colours and fonts are literal (no CSS
// variables, no webfonts) — the file must render correctly on any background.
//
// The graphics NEVER add a label, rating, or claim that was not measured.

'use strict';

// Brand palette (literal — these files travel outside the site).
const BRAND = {
  void: '#0C0C0E',
  paper: '#F5F2EE',
  paper2: '#EEEAE2',
  ink: '#101012',
  gold: '#C9A86A',
  track: '#DED8CE',
  trackDark: '#26262A',
  muted: '#8A8579',
  green: '#4A9965',
  amber: '#9A6A14',
  red: '#B13D3D'
};

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Helvetica, Arial, sans-serif";

const PILLAR_ORDER = ['clarity', 'trust', 'difference', 'ease'];
const PILLAR_LABELS = { clarity: 'Clarity', trust: 'Trust', difference: 'Difference', ease: 'Ease' };

// Same score band the rest of the report uses (see index.html canvas share img).
function scoreColor(score) {
  return score >= 76 ? BRAND.green : score >= 56 ? BRAND.amber : BRAND.red;
}
function scoreWord(score) {
  return score >= 76 ? 'Strong' : score >= 56 ? 'Building' : 'At risk';
}

// XML-escape any user-supplied text before it goes into the SVG.
function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clampScore(n, max) {
  const v = Math.round(Number(n));
  if (!isFinite(v)) return null;
  return Math.max(0, Math.min(max, v));
}

function readPillars(result) {
  const out = [];
  const p = (result && result.pillars) || {};
  PILLAR_ORDER.forEach(function (key) {
    const raw = p[key] && p[key].score;
    const val = clampScore(raw, 25);
    if (val === null) return;
    out.push({ key: key, label: PILLAR_LABELS[key], score: val });
  });
  return out;
}

// ── Asset 1: circular score dial ───────────────────────────────────────────
function scoreDialSvg(score, businessName) {
  const cx = 140, cy = 130, r = 100;
  const C = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 100));
  const dash = (C * frac).toFixed(2);
  const gap = (C * (1 - frac)).toFixed(2);
  const col = scoreColor(score);
  const word = scoreWord(score);
  const name = businessName ? xml(businessName) : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="344" viewBox="0 0 280 344" role="img" aria-label="CHOIVE score dial">'
    + '<rect width="280" height="344" rx="18" fill="' + BRAND.paper + '"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + BRAND.track + '" stroke-width="18"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="18" stroke-linecap="round"'
    + ' stroke-dasharray="' + dash + ' ' + gap + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>'
    + '<text x="' + cx + '" y="' + (cy - 2) + '" font-family="' + SERIF + '" font-size="58" font-weight="700" fill="' + BRAND.ink + '" text-anchor="middle" dominant-baseline="central">' + score + '</text>'
    + '<text x="' + cx + '" y="' + (cy + 36) + '" font-family="' + SANS + '" font-size="12" letter-spacing="2" fill="' + BRAND.muted + '" text-anchor="middle">OUT OF 100</text>'
    + '<text x="' + cx + '" y="268" font-family="' + SANS + '" font-size="15" font-weight="700" letter-spacing="1" fill="' + col + '" text-anchor="middle">' + word.toUpperCase() + '</text>'
    + '<text x="' + cx + '" y="302" font-family="' + SERIF + '" font-size="18" font-weight="700" fill="' + BRAND.ink + '" text-anchor="middle">CHOIVE</text>'
    + '<text x="' + cx + '" y="322" font-family="' + SANS + '" font-size="11" letter-spacing="1" fill="' + BRAND.muted + '" text-anchor="middle">' + (name ? (name.length > 34 ? name.slice(0, 33) + '\u2026' : name) : 'AI Selection Index') + '</text>'
    + '</svg>';
}

// ── Asset 2: four-pillar bar chart ──────────────────────────────────────────
function pillarBarsSvg(pillars) {
  const W = 460, padX = 26, top = 66, rowH = 54, barX = 150, barW = 260, barH = 16;
  const H = top + pillars.length * rowH + 20;
  var rows = pillars.map(function (p, i) {
    const y = top + i * rowH;
    const frac = Math.max(0, Math.min(1, p.score / 25));
    const fillW = (barW * frac).toFixed(1);
    const col = scoreColor(p.score * 4); // scale 0-25 to 0-100 for the same band
    return '<text x="' + padX + '" y="' + (y + barH) + '" font-family="' + SANS + '" font-size="14" font-weight="700" fill="' + BRAND.ink + '">' + xml(p.label) + '</text>'
      + '<rect x="' + barX + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="8" fill="' + BRAND.track + '"/>'
      + '<rect x="' + barX + '" y="' + y + '" width="' + fillW + '" height="' + barH + '" rx="8" fill="' + col + '"/>'
      + '<text x="' + (barX + barW + 10) + '" y="' + (y + barH) + '" font-family="' + SANS + '" font-size="13" font-weight="700" fill="' + BRAND.muted + '">' + p.score + '/25</text>';
  }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CHOIVE four-pillar scores">'
    + '<rect width="' + W + '" height="' + H + '" rx="18" fill="' + BRAND.paper + '"/>'
    + '<text x="' + padX + '" y="34" font-family="' + SERIF + '" font-size="18" font-weight="700" fill="' + BRAND.ink + '">The Four CHOIVE Pillars</text>'
    + '<text x="' + padX + '" y="52" font-family="' + SANS + '" font-size="11" letter-spacing="1" fill="' + BRAND.muted + '">Each area is scored out of 25</text>'
    + rows
    + '</svg>';
}

// ── Asset 3: shareable branded score card ───────────────────────────────────
function scoreCardSvg(score, pillars, businessName) {
  const W = 1200, H = 630;
  const col = scoreColor(score);
  const word = scoreWord(score);
  const name = businessName ? xml(businessName) : 'Your Business';
  // Dial on the left.
  const cx = 320, cy = 300, r = 150;
  const C = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 100));
  const dash = (C * frac).toFixed(2);
  const gap = (C * (1 - frac)).toFixed(2);
  // Pillar bars on the right.
  var barTop = 210, barX = 640, barW = 380, barH = 20, rowH = 66;
  var bars = pillars.map(function (p, i) {
    const y = barTop + i * rowH;
    const f = Math.max(0, Math.min(1, p.score / 25));
    const fw = (barW * f).toFixed(1);
    const bc = scoreColor(p.score * 4);
    return '<text x="' + barX + '" y="' + (y - 8) + '" font-family="' + SANS + '" font-size="18" font-weight="700" fill="' + BRAND.paper + '">' + xml(p.label) + '</text>'
      + '<text x="' + (barX + barW) + '" y="' + (y - 8) + '" font-family="' + SANS + '" font-size="16" font-weight="700" fill="' + BRAND.gold + '" text-anchor="end">' + p.score + '/25</text>'
      + '<rect x="' + barX + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="10" fill="' + BRAND.trackDark + '"/>'
      + '<rect x="' + barX + '" y="' + y + '" width="' + fw + '" height="' + barH + '" rx="10" fill="' + bc + '"/>';
  }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CHOIVE score card for ' + name + '">'
    + '<rect width="' + W + '" height="' + H + '" fill="' + BRAND.void + '"/>'
    + '<rect x="0" y="0" width="' + W + '" height="6" fill="' + BRAND.gold + '"/>'
    + '<text x="60" y="70" font-family="' + SERIF + '" font-size="30" font-weight="700" fill="' + BRAND.paper + '">CHOIVE</text>'
    + '<text x="60" y="96" font-family="' + SANS + '" font-size="14" letter-spacing="2" fill="' + BRAND.muted + '">AI SELECTION INDEX</text>'
    // dial
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + BRAND.trackDark + '" stroke-width="26"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="26" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + gap + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>'
    + '<text x="' + cx + '" y="' + (cy - 6) + '" font-family="' + SERIF + '" font-size="96" font-weight="700" fill="' + BRAND.paper + '" text-anchor="middle" dominant-baseline="central">' + score + '</text>'
    + '<text x="' + cx + '" y="' + (cy + 58) + '" font-family="' + SANS + '" font-size="16" letter-spacing="2" fill="' + BRAND.muted + '" text-anchor="middle">OUT OF 100</text>'
    + '<text x="' + cx + '" y="' + (cy + 210) + '" font-family="' + SANS + '" font-size="20" font-weight="700" letter-spacing="1" fill="' + col + '" text-anchor="middle">' + word.toUpperCase() + '</text>'
    // right column
    + '<text x="' + barX + '" y="150" font-family="' + SERIF + '" font-size="34" font-weight="700" fill="' + BRAND.paper + '">' + (name.length > 30 ? name.slice(0, 29) + '\u2026' : name) + '</text>'
    + bars
    + '<text x="60" y="590" font-family="' + SERIF + '" font-size="18" font-style="italic" fill="' + BRAND.gold + '">Be the answer. Not the alternative.</text>'
    + '<text x="' + (W - 60) + '" y="590" font-family="' + SANS + '" font-size="16" font-weight="700" fill="' + BRAND.muted + '" text-anchor="end">choive.com</text>'
    + '</svg>';
}

function buildVisualAssets(result, input) {
  const unavailable = { available: false, scoreDial: null, pillarBars: null, scoreCard: null };
  if (!result || typeof result !== 'object') return unavailable;
  const score = clampScore(result.overallScore, 100);
  if (score === null) return unavailable;
  const pillars = readPillars(result);
  const businessName = (input && input.name) || (result.businessUnderstanding && result.businessUnderstanding.name) || '';

  const assets = {
    available: true,
    score: score,
    businessName: businessName || '',
    scoreDial: scoreDialSvg(score, businessName)
  };
  // Pillar-based assets only render when we actually have pillar scores.
  if (pillars.length === 4) {
    assets.pillarBars = pillarBarsSvg(pillars);
    assets.scoreCard = scoreCardSvg(score, pillars, businessName);
  } else {
    assets.pillarBars = null;
    assets.scoreCard = null;
  }
  return assets;
}

module.exports = { buildVisualAssets, scoreColor, scoreWord };
