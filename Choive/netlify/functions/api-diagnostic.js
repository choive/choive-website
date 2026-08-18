// api-diagnostic.js
// CHOIVE™ public API — lets developers start a CHOIVE check and read the result
// from their own code, using an API key.
//
// Auth: send your key in the "X-API-Key" header. We store only the SHA-256 hash
// of each key (see db/api_keys.sql), so keys are never kept in plain text.
//
// Endpoints (same URL, different method):
//   POST /.netlify/functions/api-diagnostic
//     Body: { "name", "website", "category", "city", ... same fields as the site }
//     -> { "jobId", "status": "queued" }
//   GET  /.netlify/functions/api-diagnostic?jobId=UUID
//     -> { "jobId", "status", "stage", "score", "result" }
//
// Rate limit: each key has a daily_limit (default 50 new checks per day).
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const supabase = require('./lib/supabase');
const valid = require('./lib/validators');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { realtime: { transport: ws } });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(statusCode, obj) {
  return { statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function getApiKey(event) {
  var h = event.headers || {};
  return String(h['x-api-key'] || h['X-API-Key'] || h['x-api-key'.toLowerCase()] || '').trim();
}

// Look up the active key row by its hash. Returns null if not found/inactive.
async function findKey(rawKey) {
  if (!rawKey) return null;
  var keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  var db = getClient();
  var { data, error } = await db
    .from('api_keys')
    .select('id, label, active, daily_limit')
    .eq('key_hash', keyHash)
    .eq('active', true)
    .maybeSingle();
  if (error) { console.warn('api-diagnostic: key lookup failed:', error.message); return null; }
  return data || null;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Returns { allowed, used, limit }. Increments usage when allowed.
async function checkAndBumpUsage(keyRow) {
  var db = getClient();
  var day = todayUtc();
  var { data: usage } = await db
    .from('api_usage')
    .select('id, count')
    .eq('api_key_id', keyRow.id)
    .eq('usage_date', day)
    .maybeSingle();

  var used = usage ? (usage.count || 0) : 0;
  if (used >= keyRow.daily_limit) {
    return { allowed: false, used: used, limit: keyRow.daily_limit };
  }

  if (usage) {
    await db.from('api_usage').update({ count: used + 1, updated_at: new Date().toISOString() }).eq('id', usage.id);
  } else {
    await db.from('api_usage').insert({ api_key_id: keyRow.id, usage_date: day, count: 1 });
  }
  // Best-effort stamp of last use.
  await db.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', keyRow.id).catch(function () {});
  return { allowed: true, used: used + 1, limit: keyRow.daily_limit };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  var rawKey = getApiKey(event);
  if (!rawKey) return json(401, { error: 'Missing API key. Send it in the X-API-Key header.' });

  var keyRow;
  try { keyRow = await findKey(rawKey); }
  catch (err) { return json(500, { error: 'Could not check your API key.' }); }
  if (!keyRow) return json(403, { error: 'Invalid or inactive API key.' });

  // ── GET: read a diagnostic's status/result ─────────────────────────────────
  if (event.httpMethod === 'GET') {
    var jobId = ((event.queryStringParameters || {}).jobId || '').trim();
    if (!jobId) return json(400, { error: 'Missing jobId query parameter.' });
    try {
      var diag = await supabase.getDiagnostic(jobId);
      if (!diag) return json(404, { error: 'Diagnostic not found.' });
      var score = (diag.result && isFinite(Number(diag.result.overallScore))) ? Math.round(Number(diag.result.overallScore)) : null;
      return json(200, {
        jobId: diag.job_id,
        status: diag.status,
        stage: diag.stage || null,
        score: score,
        result: diag.status === 'complete' ? (diag.result || null) : null
      });
    } catch (err) {
      console.error('api-diagnostic GET error:', err);
      return json(500, { error: 'Could not fetch the diagnostic.' });
    }
  }

  // ── POST: start a new diagnostic ───────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    var body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400, { error: 'Invalid JSON body.' }); }

    if (body.website) body.website = valid.normalizeWebsite(body.website);
    var validation = valid.validateInput(body);
    if (!validation.valid) return json(400, { error: validation.error });

    // Enforce the per-key daily limit.
    var usage;
    try { usage = await checkAndBumpUsage(keyRow); }
    catch (err) { return json(500, { error: 'Could not check your usage limit.' }); }
    if (!usage.allowed) {
      return json(429, { error: 'Daily limit reached (' + usage.limit + ' checks per day). Try again tomorrow.' });
    }

    var input = {
      name: String(body.name || '').trim(),
      category: String(body.category || '').trim(),
      city: String(body.city || '').trim(),
      website: valid.normalizeWebsite(body.website),
      description: String(body.description || '').trim(),
      knownCompetitors: String(body.knownCompetitors || '').trim(),
      customerQuestion: String(body.customerQuestion || '').trim(),
      marketReach: ['local', 'regional', 'national', 'international', 'global'].indexOf(String(body.marketReach || '').trim().toLowerCase()) !== -1
        ? String(body.marketReach).trim().toLowerCase() : '',
      subjectType: ['business', 'product', 'creator', 'personal_brand', 'organization'].indexOf(String(body.subjectType || 'business')) !== -1
        ? String(body.subjectType || 'business') : 'business',
      _apiKeyLabel: keyRow.label || ''
    };

    var jobId = crypto.randomUUID();
    try {
      await supabase.createDiagnostic(jobId, input, null);
    } catch (err) {
      console.error('api-diagnostic: create failed:', err.message);
      return json(500, { error: 'Failed to start the diagnostic.' });
    }

    var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
    try {
      var triggerRes = await fetch(siteUrl + '/.netlify/functions/run-diagnostic-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': process.env.INTERNAL_DIAGNOSTIC_SECRET || process.env.INTERNAL_REPORT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
        },
        body: JSON.stringify({ jobId: jobId, input: input })
      });
      if (!triggerRes.ok) throw new Error('Background trigger HTTP ' + triggerRes.status);
    } catch (err) {
      console.error('api-diagnostic: trigger failed:', err.message);
      await supabase.saveError(jobId, 'API background trigger failed: ' + err.message).catch(function () {});
      return json(502, { error: 'Could not start the diagnostic engine. Please try again.' });
    }

    return json(200, {
      jobId: jobId,
      status: 'queued',
      pollUrl: '/.netlify/functions/api-diagnostic?jobId=' + jobId,
      usedToday: usage.used,
      dailyLimit: usage.limit
    });
  }

  return json(405, { error: 'Method Not Allowed' });
};
