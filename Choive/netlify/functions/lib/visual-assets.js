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
//
// The "Verified Kit" marks (seal, card, story, certificate, chip) each carry a
// real QR code that points to the live verification page for THIS result, so a
// scan always resolves to the genuine, current score. The QR is drawn straight
// into the SVG (see lib/qr.js) — no webfont, no network, no canvas.

'use strict';

const { qrSvg } = require('./qr.js');

// Build the verification URL a QR should encode for this result. It points at
// the dedicated /verify page, which reads the job id and shows the real score.
// Never a fabricated link — falls back to the generic /verify page.
function verifyUrl(opts) {
  if (opts && opts.verifyUrl) return String(opts.verifyUrl);
  const origin = ((opts && opts.origin) || 'https://choive.com').replace(/\/+$/, '');
  const jobId = opts && opts.jobId ? String(opts.jobId) : '';
  const base = origin + '/verify';
  return jobId ? base + '?j=' + encodeURIComponent(jobId) : base;
}

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
  ghost: '#B8B2A6',
  goldDark: '#A8863F',
  goldLight: '#EAD59B',
  goldDeep: '#7E6224',
  green: '#4A9965',
  amber: '#9A6A14',
  red: '#B13D3D'
};

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Helvetica, Arial, sans-serif";
// Cursive fallback stack for the signature. Standalone SVG cannot rely on a
// webfont, so we use widely-installed script faces and fall back to cursive.
const SCRIPT = "'Segoe Script', 'Brush Script MT', 'Snell Roundhand', 'Apple Chancery', cursive";

// Founder who signs the certificate. Real person (see project brief).
const FOUNDER_NAME = 'Blessing Ashionye Ebogu';
const FOUNDER_TITLE = 'Founder, CHOIVE';

// Format an issue date honestly (the day the certificate was produced, or a
// real recorded completion date if one is supplied). Never a fabricated date.
function formatIssueDate(opts, result) {
  var raw = (opts && opts.issuedDate)
    || (result && (result.completedAt || result.generatedAt || result.createdAt))
    || null;
  var d = raw ? new Date(raw) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  var months = ['January','February','March','April','May','June','July',
    'August','September','October','November','December'];
  return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

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

// Shared: two concentric arcs forming a progress dial (track + filled portion).
function dialArcs(cx, cy, r, sw, score, track, col) {
  const C = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 100));
  const dash = (C * frac).toFixed(1);
  const gap = (C * (1 - frac)).toFixed(1);
  return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + track + '" stroke-width="' + sw + '"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + sw
    + '" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + gap + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
}

// Trim a business name so it never overflows its mark.
function fit(name, max) {
  return name.length > max ? name.slice(0, max - 1) + '\u2026' : name;
}

// Truncate the RAW name first, THEN XML-escape — so truncation can never cut
// through an escaped entity (e.g. "&gt;") and produce invalid markup.
function clipName(raw, max, fallback) {
  const s = String(raw == null ? '' : raw);
  if (!s) return fallback || '';
  return xml(fit(s, max));
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

// ── Asset 4: signed certificate of AI visibility (modern portrait) ──────────
// A clean, printable portrait certificate built ONLY from the real recorded
// score and a real issue date. It states the measured result and nothing more
// — no ranking, no "best", no promise. Signed by the founder. If a real
// signature image is supplied (opts.signatureDataUri) it is embedded; otherwise
// the founder's name is rendered in a script style. Carries a QR that scans to
// the live verification page for this exact result.
function certificateSvg(score, businessName, opts, result) {
  const W = 1240, H = 1600;
  const col = scoreColor(score);
  const word = scoreWord(score);
  const name = businessName ? xml(businessName) : 'This Business';
  const shownName = clipName(businessName, 40, 'This Business');
  const issued = xml(formatIssueDate(opts, result));
  const cx = W / 2;
  const vurl = xml(verifyUrl(opts));
  const sigDataUri = opts && opts.signatureDataUri ? String(opts.signatureDataUri) : '';
  // Signature: real image if provided, otherwise script-style name.
  const sigMark = sigDataUri
    ? '<image href="' + xml(sigDataUri) + '" x="180" y="1252" width="300" height="60" preserveAspectRatio="xMidYMax meet"/>'
    : '<text x="330" y="1300" font-family="' + SCRIPT + '" font-size="46" font-style="italic" fill="' + BRAND.ink + '" text-anchor="middle" textLength="300" lengthAdjust="spacingAndGlyphs">' + xml(FOUNDER_NAME) + '</text>';
  // Compact embossed gold foil seal — centred between the score word and the signature row (official look)
  const sealCx = cx, sealCy = 1190, sealR = 62;
  const certSeal = '<g>'
    + (function () { var out = '', N = 40, R = sealR + 8; for (var i = 0; i < N; i++) { var a = (i / N) * Math.PI * 2; out += '<circle cx="' + (sealCx + R * Math.cos(a)).toFixed(1) + '" cy="' + (sealCy + R * Math.sin(a)).toFixed(1) + '" r="4.5" fill="url(#certFoil)"/>'; } return out; })()
    + '<circle cx="' + sealCx + '" cy="' + sealCy + '" r="' + sealR + '" fill="url(#certFoil)"/>'
    + '<circle cx="' + sealCx + '" cy="' + sealCy + '" r="' + (sealR - 6) + '" fill="none" stroke="' + BRAND.goldDeep + '" stroke-width="1.5" opacity="0.6"/>'
    + '<circle cx="' + sealCx + '" cy="' + sealCy + '" r="' + (sealR - 20) + '" fill="none" stroke="' + BRAND.goldLight + '" stroke-width="1" opacity="0.5"/>'
    + '<text x="' + sealCx + '" y="' + (sealCy - 16) + '" font-family="' + SANS + '" font-size="28" font-weight="700" fill="' + BRAND.void + '" text-anchor="middle" dominant-baseline="central">\u2713</text>'
    + '<text x="' + sealCx + '" y="' + (sealCy + 14) + '" font-family="' + SANS + '" font-size="15" font-weight="700" letter-spacing="3" fill="' + BRAND.void + '" text-anchor="middle">VERIFIED</text>'
    + '<text x="' + sealCx + '" y="' + (sealCy + 34) + '" font-family="' + SANS + '" font-size="9" font-weight="600" letter-spacing="0.5" fill="' + BRAND.goldDeep + '" text-anchor="middle">AI VISIBILITY</text>'
    + '</g>';

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CHOIVE certificate for ' + name + '">'
    + '<defs><radialGradient id="certFoil" cx="38%" cy="32%" r="75%">'
    + '<stop offset="0" stop-color="' + BRAND.goldLight + '"/><stop offset="0.45" stop-color="' + BRAND.gold + '"/>'
    + '<stop offset="0.8" stop-color="' + BRAND.goldDark + '"/><stop offset="1" stop-color="' + BRAND.goldDeep + '"/></radialGradient></defs>'
    + '<rect width="' + W + '" height="' + H + '" fill="' + BRAND.paper + '"/>'
    + '<rect x="0" y="0" width="' + W + '" height="14" fill="' + BRAND.gold + '"/>'
    + '<rect x="0" y="' + (H - 14) + '" width="' + W + '" height="14" fill="' + BRAND.gold + '"/>'
    // header
    + '<text x="' + cx + '" y="150" font-family="' + SERIF + '" font-size="40" font-weight="700" letter-spacing="6" fill="' + BRAND.ink + '" text-anchor="middle">CHOIVE</text>'
    + '<text x="' + cx + '" y="188" font-family="' + SANS + '" font-size="20" letter-spacing="6" fill="' + BRAND.muted + '" text-anchor="middle">AI SELECTION INDEX</text>'
    // title
    + '<text x="' + cx + '" y="360" font-family="' + SANS + '" font-size="26" letter-spacing="8" fill="' + BRAND.muted + '" text-anchor="middle">CERTIFICATE OF AI VISIBILITY</text>'
    + '<line x1="' + (cx - 90) + '" y1="400" x2="' + (cx + 90) + '" y2="400" stroke="' + BRAND.gold + '" stroke-width="3"/>'
    // recipient
    + '<text x="' + cx + '" y="480" font-family="' + SANS + '" font-size="24" fill="' + BRAND.muted + '" text-anchor="middle">This certifies that</text>'
    + '<text x="' + cx + '" y="560" font-family="' + SERIF + '" font-size="64" font-weight="700" fill="' + BRAND.ink + '" text-anchor="middle">' + shownName + '</text>'
    + '<text x="' + cx + '" y="620" font-family="' + SANS + '" font-size="24" fill="' + BRAND.muted + '" text-anchor="middle">achieved a verified AI Visibility Score of</text>'
    // the real score, on a dial
    + dialArcs(cx, 860, 175, 22, score, BRAND.paper2, col)
    + '<text x="' + cx + '" y="845" font-family="' + SERIF + '" font-size="180" font-weight="700" fill="' + col + '" text-anchor="middle" dominant-baseline="central">' + score + '</text>'
    + '<text x="' + cx + '" y="960" font-family="' + SANS + '" font-size="24" letter-spacing="4" fill="' + BRAND.muted + '" text-anchor="middle">OUT OF 100</text>'
    + '<text x="' + cx + '" y="1090" font-family="' + SANS + '" font-size="30" font-weight="700" letter-spacing="6" fill="' + col + '" text-anchor="middle">' + word.toUpperCase() + '</text>'
    // embossed gold verification seal
    + certSeal
    // signature (left) and date (right)
    + sigMark
    + '<line x1="180" y1="1330" x2="480" y2="1330" stroke="' + BRAND.ink + '" stroke-width="1"/>'
    + '<text x="330" y="1362" font-family="' + SANS + '" font-size="20" font-weight="700" fill="' + BRAND.ink + '" text-anchor="middle">' + xml(FOUNDER_NAME) + '</text>'
    + '<text x="330" y="1388" font-family="' + SANS + '" font-size="17" fill="' + BRAND.muted + '" text-anchor="middle">' + xml(FOUNDER_TITLE) + '</text>'
    + '<text x="910" y="1310" font-family="' + SERIF + '" font-size="26" fill="' + BRAND.ink + '" text-anchor="middle">' + issued + '</text>'
    + '<line x1="760" y1="1330" x2="1060" y2="1330" stroke="' + BRAND.ink + '" stroke-width="1"/>'
    + '<text x="910" y="1362" font-family="' + SANS + '" font-size="20" font-weight="700" fill="' + BRAND.ink + '" text-anchor="middle">Date issued</text>'
    // QR to the live verification page
    + '<rect x="' + (cx - 45) + '" y="1420" width="90" height="90" rx="6" fill="' + BRAND.paper + '" stroke="' + BRAND.paper2 + '" stroke-width="1"/>'
    + qrSvg(verifyUrl(opts), cx - 37, 1428, 74, { dark: BRAND.ink })
    + '<text x="' + cx + '" y="1545" font-family="' + SANS + '" font-size="18" fill="' + BRAND.muted + '" text-anchor="middle">Scan to verify \u00b7 ' + vurl.replace(/^https?:\/\//, '') + '</text>'
    + '</svg>';
}

// ── Kit 1: "The Seal" — circular verified emblem, square social (1080) ──────
function sealSvg(score, businessName, opts) {
  const W = 1080, H = 1080, cx = 540, cy = 540;
  const col = scoreColor(score);
  const shownName = clipName(businessName, 30, 'Your Business');
  const tr = 424;
  // Scalloped foil edge — small beads around the perimeter (classic notary/foil-seal look)
  const beads = (function () {
    var out = '', N = 60, R = 492;
    for (var i = 0; i < N; i++) {
      var a = (i / N) * Math.PI * 2;
      var bx = cx + R * Math.cos(a), by = cy + R * Math.sin(a);
      out += '<circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="11" fill="url(#foil)"/>';
    }
    return out;
  })();
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CHOIVE verified seal">'
    + '<defs>'
    // metallic gold foil: light sheen top-left, deep gold bottom-right
    + '<radialGradient id="foil" cx="38%" cy="32%" r="75%">'
    + '<stop offset="0" stop-color="' + BRAND.goldLight + '"/><stop offset="0.45" stop-color="' + BRAND.gold + '"/>'
    + '<stop offset="0.8" stop-color="' + BRAND.goldDark + '"/><stop offset="1" stop-color="' + BRAND.goldDeep + '"/></radialGradient>'
    // recessed inner field (embossed-in look)
    + '<radialGradient id="field" cx="50%" cy="42%" r="70%">'
    + '<stop offset="0" stop-color="#1A1A1E"/><stop offset="1" stop-color="' + BRAND.void + '"/></radialGradient>'
    // soft outer drop shadow
    + '<filter id="sealShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000" flood-opacity="0.55"/></filter>'
    // top rim highlight arc + bottom shading for the metal ring
    + '<linearGradient id="ring" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + BRAND.goldLight + '"/><stop offset="0.5" stop-color="' + BRAND.gold + '"/><stop offset="1" stop-color="' + BRAND.goldDeep + '"/></linearGradient>'
    + '<path id="cta" d="M ' + (cx - tr) + ' ' + cy + ' a ' + tr + ' ' + tr + ' 0 1 1 ' + (2 * tr) + ' 0"/>'
    + '<path id="ctb" d="M ' + (cx - tr + 20) + ' ' + cy + ' a ' + (tr - 20) + ' ' + (tr - 20) + ' 0 1 0 ' + (2 * (tr - 20)) + ' 0"/>'
    + '</defs>'
    + '<rect width="' + W + '" height="' + H + '" fill="' + BRAND.void + '"/>'
    + '<g filter="url(#sealShadow)">'
    + beads
    // outer metal medallion
    + '<circle cx="' + cx + '" cy="' + cy + '" r="478" fill="url(#foil)"/>'
    // embossed groove rings
    + '<circle cx="' + cx + '" cy="' + cy + '" r="474" fill="none" stroke="' + BRAND.goldDeep + '" stroke-width="2" opacity="0.6"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="452" fill="none" stroke="url(#ring)" stroke-width="6"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="438" fill="none" stroke="' + BRAND.goldDeep + '" stroke-width="2" opacity="0.5"/>'
    // recessed dark field
    + '<circle cx="' + cx + '" cy="' + cy + '" r="360" fill="url(#field)"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="360" fill="none" stroke="' + BRAND.goldDeep + '" stroke-width="4" opacity="0.7"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="354" fill="none" stroke="' + BRAND.goldLight + '" stroke-width="1" opacity="0.25"/>'
    + '</g>'
    // curved embossed text on the gold ring (shadow layer + highlight layer)
    + '<text font-family="' + SANS + '" font-size="30" font-weight="700" letter-spacing="8" fill="' + BRAND.goldDeep + '" opacity="0.55"><textPath href="#cta" startOffset="50.3%" text-anchor="middle">VERIFIED  AI  VISIBILITY</textPath></text>'
    + '<text font-family="' + SANS + '" font-size="30" font-weight="700" letter-spacing="8" fill="' + BRAND.void + '"><textPath href="#cta" startOffset="50%" text-anchor="middle">VERIFIED  AI  VISIBILITY</textPath></text>'
    + '<text font-family="' + SANS + '" font-size="21" font-weight="600" letter-spacing="6" fill="' + BRAND.goldDeep + '"><textPath href="#ctb" startOffset="50%" text-anchor="middle">CHOIVE  \u00b7  AI  SELECTION  INDEX</textPath></text>'
    // score dial + embossed number on the recessed field
    + dialArcs(cx, cy - 30, 250, 26, score, BRAND.trackDark, col)
    + '<text x="' + cx + '" y="' + (cy - 62) + '" font-family="' + SERIF + '" font-size="190" font-weight="700" fill="' + BRAND.paper + '" text-anchor="middle" dominant-baseline="central">' + score + '</text>'
    + '<text x="' + cx + '" y="' + (cy + 66) + '" font-family="' + SANS + '" font-size="26" letter-spacing="8" fill="' + BRAND.muted + '" text-anchor="middle">OUT OF 100</text>'
    + '<text x="' + cx + '" y="' + (cy + 132) + '" font-family="' + SANS + '" font-size="34" font-weight="700" letter-spacing="6" fill="' + col + '" text-anchor="middle">' + scoreWord(score).toUpperCase() + '</text>'
    // gold ribbon banner with the business name
    + '<g filter="url(#sealShadow)">'
    + '<path d="M 250 ' + (cy + 236) + ' L 830 ' + (cy + 236) + ' L 830 ' + (cy + 300) + ' L 250 ' + (cy + 300) + ' Z" fill="url(#ring)"/>'
    + '<path d="M 220 ' + (cy + 248) + ' L 250 ' + (cy + 236) + ' L 250 ' + (cy + 300) + ' L 220 ' + (cy + 312) + ' Z" fill="' + BRAND.goldDeep + '"/>'
    + '<path d="M 860 ' + (cy + 248) + ' L 830 ' + (cy + 236) + ' L 830 ' + (cy + 300) + ' L 860 ' + (cy + 312) + ' Z" fill="' + BRAND.goldDeep + '"/>'
    + '</g>'
    + '<text x="' + cx + '" y="' + (cy + 270) + '" font-family="' + SERIF + '" font-size="34" font-weight="700" fill="' + BRAND.void + '" text-anchor="middle" dominant-baseline="central">' + shownName + '</text>'
    + '</svg>';
}

// ── Kit 2: "The Card" — modern square social card with QR (1080) ────────────
function cardSvg(score, pillars, businessName, opts) {
  const W = 1080, H = 1080;
  const col = scoreColor(score);
  const name = businessName ? xml(businessName) : 'Your Business';
  const bx = 120, by = 660, bw = 840, rowh = 64;
  var bars = pillars.map(function (p, i) {
    const y = by + i * rowh;
    const f = Math.max(0, Math.min(1, p.score / 25));
    return '<text x="' + bx + '" y="' + (y - 6) + '" font-family="' + SANS + '" font-size="26" font-weight="700" fill="' + BRAND.paper + '">' + xml(p.label) + '</text>'
      + '<text x="' + (bx + bw) + '" y="' + (y - 6) + '" font-family="' + SANS + '" font-size="24" font-weight="700" fill="' + BRAND.gold + '" text-anchor="end">' + p.score + '/25</text>'
      + '<rect x="' + bx + '" y="' + y + '" width="' + bw + '" height="14" rx="7" fill="' + BRAND.trackDark + '"/>'
      + '<rect x="' + bx + '" y="' + y + '" width="' + (bw * f).toFixed(0) + '" height="14" rx="7" fill="' + scoreColor(p.score * 4) + '"/>';
  }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CHOIVE score card for ' + name + '">'
    + '<rect width="' + W + '" height="' + H + '" fill="' + BRAND.void + '"/>'
    + '<rect x="0" y="0" width="' + W + '" height="8" fill="' + BRAND.gold + '"/>'
    + '<text x="120" y="130" font-family="' + SERIF + '" font-size="46" font-weight="700" letter-spacing="4" fill="' + BRAND.paper + '">CHOIVE</text>'
    + '<text x="120" y="168" font-family="' + SANS + '" font-size="22" letter-spacing="5" fill="' + BRAND.muted + '">AI SELECTION INDEX</text>'
    + '<text x="' + (W - 120) + '" y="150" font-family="' + SANS + '" font-size="24" font-weight="700" letter-spacing="3" fill="' + BRAND.gold + '" text-anchor="end">\u2713 VERIFIED</text>'
    + dialArcs(300, 400, 150, 26, score, BRAND.trackDark, col)
    + '<text x="300" y="385" font-family="' + SERIF + '" font-size="130" font-weight="700" fill="' + BRAND.paper + '" text-anchor="middle" dominant-baseline="central">' + score + '</text>'
    + '<text x="300" y="470" font-family="' + SANS + '" font-size="22" letter-spacing="4" fill="' + BRAND.muted + '" text-anchor="middle">OUT OF 100</text>'
    + '<text x="560" y="320" font-family="' + SERIF + '" font-size="52" font-weight="700" fill="' + BRAND.paper + '">' + clipName(businessName, 22, 'Your Business') + '</text>'
    + '<text x="560" y="372" font-family="' + SANS + '" font-size="30" font-weight="700" letter-spacing="4" fill="' + col + '">' + scoreWord(score).toUpperCase() + '</text>'
    + '<text x="560" y="418" font-family="' + SANS + '" font-size="24" fill="' + BRAND.ghost + '">AI Visibility Score</text>'
    + bars
    + '<line x1="120" y1="930" x2="' + (W - 120) + '" y2="930" stroke="' + BRAND.trackDark + '" stroke-width="1"/>'
    + '<rect x="120" y="960" width="90" height="90" rx="6" fill="' + BRAND.paper + '"/>'
    + qrSvg(verifyUrl(opts), 128, 968, 74, { dark: BRAND.ink })
    + '<text x="235" y="995" font-family="' + SANS + '" font-size="22" font-weight="700" fill="' + BRAND.paper + '">Scan to verify this score is real</text>'
    + '<text x="235" y="1028" font-family="' + SANS + '" font-size="20" fill="' + BRAND.muted + '">choive.com/verify \u00b7 Be the answer. Not the alternative.</text>'
    + '</svg>';
}

// ── Kit 3: "The Story" — 9:16 vertical for IG/LinkedIn stories (1080x1920) ──
function storySvg(score, businessName, opts) {
  const W = 1080, H = 1920;
  const col = scoreColor(score);
  const name = businessName ? xml(businessName) : 'Your Business';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CHOIVE verified story">'
    + '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141417"/><stop offset="1" stop-color="' + BRAND.void + '"/></linearGradient></defs>'
    + '<rect width="' + W + '" height="' + H + '" fill="url(#bg)"/>'
    + '<rect x="0" y="0" width="' + W + '" height="10" fill="' + BRAND.gold + '"/>'
    + '<text x="' + (W / 2) + '" y="260" font-family="' + SERIF + '" font-size="60" font-weight="700" letter-spacing="6" fill="' + BRAND.paper + '" text-anchor="middle">CHOIVE</text>'
    + '<text x="' + (W / 2) + '" y="308" font-family="' + SANS + '" font-size="26" letter-spacing="7" fill="' + BRAND.muted + '" text-anchor="middle">AI SELECTION INDEX</text>'
    + '<text x="' + (W / 2) + '" y="470" font-family="' + SANS + '" font-size="30" font-weight="700" letter-spacing="4" fill="' + BRAND.gold + '" text-anchor="middle">\u2713  VERIFIED SCORE</text>'
    + dialArcs(W / 2, 900, 320, 34, score, BRAND.trackDark, col)
    + '<text x="' + (W / 2) + '" y="880" font-family="' + SERIF + '" font-size="260" font-weight="700" fill="' + BRAND.paper + '" text-anchor="middle" dominant-baseline="central">' + score + '</text>'
    + '<text x="' + (W / 2) + '" y="1010" font-family="' + SANS + '" font-size="30" letter-spacing="6" fill="' + BRAND.muted + '" text-anchor="middle">OUT OF 100</text>'
    + '<text x="' + (W / 2) + '" y="1300" font-family="' + SANS + '" font-size="40" font-weight="700" letter-spacing="6" fill="' + col + '" text-anchor="middle">' + scoreWord(score).toUpperCase() + '</text>'
    + '<text x="' + (W / 2) + '" y="1400" font-family="' + SERIF + '" font-size="56" font-weight="700" fill="' + BRAND.paper + '" text-anchor="middle">' + clipName(businessName, 30, 'Your Business') + '</text>'
    + '<text x="' + (W / 2) + '" y="1455" font-family="' + SANS + '" font-size="30" fill="' + BRAND.ghost + '" text-anchor="middle">AI Visibility Score</text>'
    + '<rect x="' + (W / 2 - 55) + '" y="1600" width="110" height="110" rx="8" fill="' + BRAND.paper + '"/>'
    + qrSvg(verifyUrl(opts), W / 2 - 46, 1609, 92, { dark: BRAND.ink })
    + '<text x="' + (W / 2) + '" y="1770" font-family="' + SANS + '" font-size="26" fill="' + BRAND.muted + '" text-anchor="middle">Scan to verify \u00b7 choive.com/verify</text>'
    + '<text x="' + (W / 2) + '" y="1840" font-family="' + SERIF + '" font-size="34" font-style="italic" fill="' + BRAND.gold + '" text-anchor="middle">Be the answer. Not the alternative.</text>'
    + '</svg>';
}

// ── Kit 4: "The Chip" — tiny horizontal badge for email/footer (light/dark) ─
function chipSvg(score, businessName, variant) {
  const W = 520, H = 150;
  const col = scoreColor(score);
  const name = businessName ? xml(businessName) : 'Your Business';
  const dark = variant === 'dark';
  const bg = dark ? BRAND.void : BRAND.paper;
  const fg = dark ? BRAND.paper : BRAND.ink;
  const sub = dark ? BRAND.ghost : BRAND.muted;
  const track = dark ? BRAND.trackDark : BRAND.paper2;
  const wordTitle = scoreWord(score); // "Strong" / "Building" / "At risk"
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="CHOIVE verified chip">'
    + '<rect width="' + W + '" height="' + H + '" rx="16" fill="' + bg + '" stroke="' + BRAND.gold + '" stroke-width="1.5"/>'
    + dialArcs(90, 75, 52, 12, score, track, col)
    + '<text x="90" y="70" font-family="' + SERIF + '" font-size="44" font-weight="700" fill="' + fg + '" text-anchor="middle" dominant-baseline="central">' + score + '</text>'
    + '<text x="90" y="118" font-family="' + SANS + '" font-size="13" letter-spacing="2" fill="' + sub + '" text-anchor="middle">/ 100</text>'
    + '<text x="180" y="55" font-family="' + SANS + '" font-size="15" font-weight="700" letter-spacing="2" fill="' + BRAND.gold + '">\u2713 VERIFIED BY CHOIVE</text>'
    + '<text x="180" y="86" font-family="' + SERIF + '" font-size="24" font-weight="700" fill="' + fg + '">' + clipName(businessName, 22, 'Your Business') + '</text>'
    + '<text x="180" y="112" font-family="' + SANS + '" font-size="15" fill="' + sub + '">AI Visibility Score \u00b7 ' + wordTitle + '</text>'
    + '</svg>';
}

function buildVisualAssets(result, input, opts) {
  const unavailable = {
    available: false,
    scoreDial: null, pillarBars: null, scoreCard: null, certificate: null,
    seal: null, card: null, story: null, chipLight: null, chipDark: null
  };
  if (!result || typeof result !== 'object') return unavailable;
  const score = clampScore(result.overallScore, 100);
  if (score === null) return unavailable;
  const o = opts || {};
  const pillars = readPillars(result);
  const businessName = (input && input.name) || (result.businessUnderstanding && result.businessUnderstanding.name) || '';

  const assets = {
    available: true,
    score: score,
    businessName: businessName || '',
    verifyUrl: verifyUrl(o),
    // Utility assets (used inside the report UI).
    scoreDial: scoreDialSvg(score, businessName),
    // The Verified Kit — branded, shareable marks that each scan back to the
    // live verification page for this exact result.
    certificate: certificateSvg(score, businessName, o, result),
    seal: sealSvg(score, businessName, o),
    story: storySvg(score, businessName, o),
    chipLight: chipSvg(score, businessName, 'light'),
    chipDark: chipSvg(score, businessName, 'dark')
  };
  // Pillar-based assets only render when we actually have all four pillar scores.
  if (pillars.length === 4) {
    assets.pillarBars = pillarBarsSvg(pillars);
    assets.scoreCard = scoreCardSvg(score, pillars, businessName);
    assets.card = cardSvg(score, pillars, businessName, o);
  } else {
    assets.pillarBars = null;
    assets.scoreCard = null;
    assets.card = null;
  }
  return assets;
}

module.exports = { buildVisualAssets, scoreColor, scoreWord, FOUNDER_NAME, verifyUrl };
