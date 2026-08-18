// badge.js
// CHOIVE™ — Tamper-proof CHOIVE Score badge (SVG).
//
// A badge is a TRUST signal, so the score must be impossible to fake. This
// endpoint NEVER trusts a score passed in the URL. It resolves the score one of
// three authenticated ways, in priority order:
//
//   ?job=<uuid>     → live lookup of the real overallScore in Supabase (best)
//   ?slug=<slug>    → resolve slug → jobId → live lookup
//   ?token=<v1...>  → HMAC-signed token minted by CHOIVE (CDN-cacheable)
//
// A "verified" badge carries a ✓ and the real, current score. If someone hits
// the endpoint with only ?score=/?business= (the old spoofable pattern), we do
// NOT render it as a CHOIVE result — we return an explicit UNVERIFIED badge so a
// made-up number can never masquerade as a measured CHOIVE Score.
//
// Query params:
//   job    : diagnostic UUID (authoritative)
//   slug   : diagnostic slug (authoritative)
//   token  : signed score token (authoritative, offline-verifiable)
//   style  : 'default' | 'flat' | 'minimal'   (default: 'default')
//   label  : custom left-hand label            (default: 'CHOIVE Score')
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CHOIVE_BADGE_SECRET (optional)

const SVGNS = 'http://www.w3.org/2000/svg';

let supabase = null;
let verifyToken = null;
try { supabase = require('./lib/supabase'); } catch (_) {}
try { ({ verifyToken } = require('./lib/badge-verify')); } catch (_) {}

const baseHeaders = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  // Verified badges can be cached briefly; scores change rarely. Short TTL keeps
  // an embedded badge reasonably fresh after a re-run.
  'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400'
};

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const style = ['flat', 'minimal', 'default'].includes(params.style) ? params.style : 'default';
  const label = sanitizeLabel(params.label || 'CHOIVE Score');

  let score = null;
  let verified = false;
  let notFound = false;

  try {
    // 1) Authoritative: signed token (no DB hit needed)
    if (params.token && verifyToken) {
      const t = verifyToken(params.token);
      if (t.valid) { score = t.score; verified = true; }
    }

    // 2) Authoritative: live Supabase lookup by jobId or slug
    if (score === null && supabase) {
      let jobId = (params.job || '').trim();
      const slug = (params.slug || '').trim();
      if (!jobId && slug && supabase.getDiagnosticBySlug) {
        const row = await supabase.getDiagnosticBySlug(slug);
        if (row && row.job_id) jobId = row.job_id;
      }
      if (jobId && supabase.getDiagnostic) {
        const diag = await supabase.getDiagnostic(jobId);
        if (diag && diag.status === 'complete' && diag.result) {
          const real = Math.round(Number(diag.result.overallScore));
          if (real >= 0 && real <= 100) { score = real; verified = true; }
        } else if (!diag) {
          notFound = true;
        }
      }
    }
  } catch (err) {
    console.error('badge: lookup failed:', err.message);
    // fall through to unverified/unavailable rendering
  }

  // 3) Unverified fallback — someone passed a raw ?score without proof, or the
  //    lookup found nothing. We render an honest "unverified"/"—" badge rather
  //    than displaying an unproven number as if CHOIVE measured it.
  let svg, statusColor;
  if (score !== null && verified) {
    statusColor = colorFor(score);
    svg = renderBadge(style, label, String(score), statusColor, true);
  } else {
    statusColor = '#94a3b8'; // slate — neutral, clearly not a score color
    const text = notFound ? 'not found' : 'unverified';
    svg = renderBadge(style, label, text, statusColor, false);
  }

  return { statusCode: 200, headers: baseHeaders, body: svg };
};

function colorFor(score) {
  if (score >= 80) return '#10b981'; // green
  if (score >= 60) return '#f59e0b'; // amber
  if (score >= 40) return '#f97316'; // orange
  return '#ef4444';                  // red
}

function sanitizeLabel(s) {
  return String(s).replace(/[<>&"']/g, '').slice(0, 40) || 'CHOIVE Score';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// value may be a number ("87") or a word ("unverified"). verified adds a ✓.
function renderBadge(style, label, value, color, verified) {
  const displayValue = verified ? ('✓ ' + value) : value;
  if (style === 'flat')    return flatBadge(label, displayValue, color);
  if (style === 'minimal') return minimalBadge(value, color, verified);
  return defaultBadge(label, displayValue, color);
}

function defaultBadge(label, value, color) {
  const labelWidth = Math.max(104, label.length * 7 + 16);
  const valueWidth = Math.max(54, value.length * 8 + 16);
  const w = labelWidth + valueWidth;
  return `<svg xmlns="${SVGNS}" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#1a1a2e"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelWidth / 2 * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 12) * 10}">${esc(label)}</text>
    <text x="${labelWidth / 2 * 10}" y="140" transform="scale(.1)" textLength="${(labelWidth - 12) * 10}">${esc(label)}</text>
    <text aria-hidden="true" x="${(labelWidth + valueWidth / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(valueWidth - 12) * 10}">${esc(value)}</text>
    <text x="${(labelWidth + valueWidth / 2) * 10}" y="140" transform="scale(.1)" textLength="${(valueWidth - 12) * 10}">${esc(value)}</text>
  </g>
</svg>`;
}

function flatBadge(label, value, color) {
  const labelWidth = Math.max(104, label.length * 7 + 16);
  const valueWidth = Math.max(54, value.length * 8 + 16);
  const w = labelWidth + valueWidth;
  return `<svg xmlns="${SVGNS}" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <g shape-rendering="crispEdges">
    <rect width="${labelWidth}" height="20" fill="#1a1a2e"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text x="${labelWidth / 2 * 10}" y="140" transform="scale(.1)" textLength="${(labelWidth - 12) * 10}">${esc(label)}</text>
    <text x="${(labelWidth + valueWidth / 2) * 10}" y="140" transform="scale(.1)" textLength="${(valueWidth - 12) * 10}">${esc(value)}</text>
  </g>
</svg>`;
}

function minimalBadge(value, color, verified) {
  const w = verified ? 92 : 100;
  const text = verified ? ('✓ ' + value) : value;
  return `<svg xmlns="${SVGNS}" width="${w}" height="20" role="img" aria-label="CHOIVE Score: ${esc(value)}">
  <title>CHOIVE Score: ${esc(value)}</title>
  <rect width="${w}" height="20" rx="3" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text x="${w / 2 * 10}" y="140" transform="scale(.1)" font-weight="bold" textLength="${(w - 16) * 10}">${esc(text)}</text>
  </g>
</svg>`;
}
