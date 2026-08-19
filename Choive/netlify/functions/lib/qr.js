// lib/qr.js
// CHOIVE™ — tiny QR helper for branded assets.
//
// Wraps the vendored, MIT-licensed qrcode-generator (lib/qr-vendor.js) and
// turns a short URL into a block of SVG <rect> elements that can be dropped
// straight into any of the branded SVG marks. No runtime dependency, no
// network, no canvas — the QR travels inside the downloadable SVG/PNG.
//
// The QR only ever encodes a real verification URL that points back to the
// live score page, so a scan always resolves to the genuine, current score.

'use strict';

const qrcode = require('./qr-vendor.js');

// Build the boolean module matrix for `text`.
// Error-correction level 'M' balances density and scan reliability; 'Q' is a
// touch more robust when a logo sits on top (we keep a quiet centre clear).
function qrMatrix(text, ecLevel) {
  const qr = qrcode(0, ecLevel || 'M'); // typeNumber 0 = auto-fit
  qr.addData(String(text == null ? '' : text));
  qr.make();
  const n = qr.getModuleCount();
  const m = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    m.push(row);
  }
  return m;
}

// Render a QR as a group of SVG rects, fitted into a `size`x`size` box at (x,y).
// `opts.dark`  — module colour (default near-black).
// `opts.light` — optional background rect colour (default: none/transparent).
// `opts.padding` — quiet-zone padding in px kept inside the box (default 0).
function qrSvg(text, x, y, size, opts) {
  opts = opts || {};
  const dark = opts.dark || '#101012';
  const pad = Number(opts.padding) || 0;
  const inner = size - pad * 2;
  const m = qrMatrix(text, opts.ecLevel);
  const n = m.length;
  const cell = inner / n;
  let out = '';
  if (opts.light) {
    out += '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="' + (opts.radius || 0) + '" fill="' + opts.light + '"/>';
  }
  const x0 = x + pad, y0 = y + pad;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) {
        const rx = (x0 + c * cell).toFixed(2);
        const ry = (y0 + r * cell).toFixed(2);
        const w = (cell + 0.4).toFixed(2); // tiny overlap kills hairline gaps in PNG raster
        out += '<rect x="' + rx + '" y="' + ry + '" width="' + w + '" height="' + w + '" fill="' + dark + '"/>';
      }
    }
  }
  return out;
}

module.exports = { qrMatrix, qrSvg };
