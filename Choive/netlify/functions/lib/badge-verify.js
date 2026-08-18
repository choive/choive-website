// lib/badge-verify.js
// CHOIVE™ — Tamper-proof badge tokens.
//
// A CHOIVE Score badge is only a *trust* signal if the number cannot be faked.
// The old badge accepted `?score=87` straight from the URL, so anyone could
// display any score. This module lets a badge be proven authentic in two ways:
//
//   1. Authoritative lookup  — the badge is requested by jobId/slug and the
//      score is read live from Supabase (see badge.js). Impossible to spoof.
//
//   2. Signed token          — a compact, self-verifying string that embeds the
//      jobId + score + issue time, signed with an HMAC secret. It can be served
//      from a CDN with no database hit and still cannot be altered without
//      invalidating the signature. Useful for high-traffic embeds.
//
// Token format:  v1.<base64url(payload)>.<base64url(hmac-sha256)>
//   payload = { j: jobId, s: score, iat: unixSeconds }
//
// ENV: CHOIVE_BADGE_SECRET (preferred). Falls back to SUPABASE_SERVICE_ROLE_KEY
//      so signing works out-of-the-box on the existing deploy; set a dedicated
//      CHOIVE_BADGE_SECRET in Netlify for clean secret separation.

const crypto = require('crypto');

function getSecret() {
  var s = process.env.CHOIVE_BADGE_SECRET
       || process.env.SUPABASE_SERVICE_ROLE_KEY
       || '';
  if (!s) throw new Error('badge-verify: no signing secret configured');
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function sign(payloadStr) {
  return b64url(
    crypto.createHmac('sha256', getSecret()).update(payloadStr).digest()
  );
}

// Create a signed token for a verified score.
// jobId: the diagnostic UUID; score: integer 0-100.
function signToken(jobId, score) {
  var payload = { j: String(jobId), s: Math.round(Number(score) || 0), iat: Math.floor(Date.now() / 1000) };
  var payloadStr = b64url(JSON.stringify(payload));
  return 'v1.' + payloadStr + '.' + sign(payloadStr);
}

// Verify a signed token. Returns { valid, jobId, score, issuedAt } — never
// throws. Uses a constant-time comparison so a bad signature can't be probed.
function verifyToken(token) {
  try {
    var parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return { valid: false };
    var payloadStr = parts[1];
    var expected = sign(payloadStr);
    var a = Buffer.from(expected);
    var b = Buffer.from(parts[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };
    var payload = JSON.parse(b64urlDecode(payloadStr).toString('utf8'));
    var score = Math.round(Number(payload.s));
    if (!(score >= 0 && score <= 100)) return { valid: false };
    return { valid: true, jobId: String(payload.j || ''), score: score, issuedAt: Number(payload.iat) || 0 };
  } catch (_) {
    return { valid: false };
  }
}

module.exports = { signToken, verifyToken };
