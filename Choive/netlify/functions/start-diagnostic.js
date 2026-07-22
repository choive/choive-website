// start-diagnostic.js
// CHOIVE Stage 1 — Entry point
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL

const crypto = require('crypto');
const supabase = require('./lib/supabase');
const valid = require('./lib/validators');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ── IP Rate Limiting ──────────────────────────────────────────────────────────
// Simple in-memory store. Resets on each cold start (acceptable for Netlify
// functions — the goal is preventing obvious abuse, not perfect enforcement).
// Limit: 3 free diagnostics per IP per hour.
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ipTracker = new Map();

function getClientIP(event) {
  var headers = event.headers || {};
  return (
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    headers['x-real-ip'] ||
    headers['client-ip'] ||
    'unknown'
  );
}

function isRateLimited(ip) {
  var now = Date.now();
  var record = ipTracker.get(ip);

  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Fresh window
    ipTracker.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return true;
  }

  record.count++;
  return false;
}

// Clean up old entries periodically to prevent memory leak
function cleanupTracker() {
  var now = Date.now();
  for (var [ip, record] of ipTracker.entries()) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      ipTracker.delete(ip);
    }
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  // Rate limit check — skipped in dev mode (set CHOIVE_DEV_MODE=true in Netlify env)
  var devMode = process.env.CHOIVE_DEV_MODE === 'true';
  var clientIP = getClientIP(event);
  cleanupTracker();
  if (!devMode && isRateLimited(clientIP)) {
    console.warn('start-diagnostic: rate limit hit for IP:', clientIP);
    return {
      statusCode: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Too many diagnostics. Please wait an hour before running another.'
      })
    };
  }

  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  var validation = valid.validateInput(body);
  if (!validation.valid) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: validation.error })
    };
  }

  var input = {
    name: String(body['name'] || '').trim(),
    category: String(body['category'] || '').trim(),
    city: String(body['city'] || '').trim(),
    website: String(body['website'] || '').trim(),
    description: String(body['description'] || '').trim(),
    knownCompetitors: String(body['knownCompetitors'] || '').trim(),
    customerQuestion: String(body['customerQuestion'] || '').trim(),
    subjectType: ['business', 'product', 'creator', 'personal_brand', 'organization'].indexOf(String(body['subjectType'] || 'business')) !== -1
      ? String(body['subjectType'] || 'business') : 'business',
    // Customer-market language override; '' = auto-detect from location
    language: (['de','es','fr','it','nl','pt','pl','tr','sv','da','ja','ko','zh','en','ar','ru','hi','id'].indexOf(String(body['language'] || '').trim().toLowerCase()) !== -1)
      ? String(body['language']).trim().toLowerCase() : ''
  };

  var verificationToken = crypto.randomBytes(32).toString('hex');
  input._consumerVerificationTokenHash = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');

  // ── DURABLE RATE CAPS (Supabase-backed; the in-memory limiter above only
  // guards a single warm instance). Per-IP daily cap + global daily ceiling.
  // Fails open, bypassed in dev mode, IPs stored only as salted hashes.
  var ipHash = null;
  try {
    var rawIp = getClientIP(event);
    if (rawIp && rawIp !== 'unknown') {
      ipHash = crypto.createHash('sha256')
        .update(rawIp + (process.env.RATE_SALT || 'choive-rate'))
        .digest('hex');
    }
  } catch (e) {}

  if (process.env.CHOIVE_DEV_MODE !== 'true') {
    var ipCap     = parseInt(process.env.RATE_IP_CAP     || '5', 10);
    var globalCap = parseInt(process.env.RATE_GLOBAL_CAP || '300', 10);
    var globalCount = await supabase.countDiagnosticsToday(null);
    if (globalCount >= globalCap) {
      return {
        statusCode: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'CHOIVE is at full capacity today — the diagnostic queue reopens tomorrow. Email hello@choive.com if it\u2019s urgent.' })
      };
    }
    if (ipHash) {
      var ipCount = await supabase.countDiagnosticsToday(ipHash);
      if (ipCount >= ipCap) {
        return {
          statusCode: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Daily limit reached — ' + ipCap + ' diagnostics per day per connection. Try again tomorrow, or email hello@choive.com if you need more.' })
        };
      }
    }
  }

  var jobId = crypto.randomUUID();

  try {
    await supabase.createDiagnostic(jobId, input, ipHash);
  } catch (err) {
    console.error('start-diagnostic: Supabase create failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to initialize diagnostic' })
    };
  }

  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
  var backgroundUrl = siteUrl + '/.netlify/functions/run-diagnostic-background';
  console.log('CHOIVE background trigger:', backgroundUrl);

  try {
    var triggerRes = await fetch(backgroundUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INTERNAL_DIAGNOSTIC_SECRET || process.env.INTERNAL_REPORT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
      },
      body: JSON.stringify({ jobId: jobId, input: input })
    });
    if (!triggerRes.ok) {
      var errText = await triggerRes.text().catch(() => 'no body');
      console.error('start-diagnostic: trigger returned', triggerRes.status, errText);
      await supabase.saveError(jobId, 'Background trigger failed: ' + triggerRes.status).catch(() => {});
      return {
        statusCode: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Diagnostic engine could not be started. Please try again.' })
      };
    }
  } catch (err) {
    console.error('start-diagnostic: trigger threw:', err.message);
    await supabase.saveError(jobId, 'Background trigger error: ' + err.message).catch(() => {});
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not start diagnostic. Please try again.' })
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: jobId, status: 'queued', verificationToken: verificationToken })
  };
};
