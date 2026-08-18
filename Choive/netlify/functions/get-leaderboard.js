// get-leaderboard.js
// Public CHOIVE leaderboard — the highest-scoring businesses, using only REAL
// completed, paid diagnostics. Nothing here is invented.
//
// Privacy first: every business is shown ANONYMOUSLY by default (for example
// "A dental clinic in Leeds"). A business is only named if its owner turned on
// the leaderboard_optin flag. If that column does not exist yet (migration not
// run), everyone is treated as anonymous — the endpoint still works.
//
// Only the latest run per business (by business_fingerprint) is counted, so a
// business cannot appear many times. A minimum sample keeps an empty or tiny
// board from looking silly.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { realtime: { transport: ws } });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

function json(statusCode, obj) {
  return { statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_BOARD_SIZE = 3;            // don't show a board with fewer than 3 businesses
let cache = null;
let cacheAt = 0;

function titleCase(s) {
  return String(s || '').replace(/\w\S*/g, function (t) { return t.charAt(0).toUpperCase() + t.slice(1); });
}

// Build a safe anonymous label that never reveals who the business is.
function anonLabel(category, city) {
  var cat = String(category || '').trim();
  var loc = String(city || '').trim();
  var catPart = cat ? ('A ' + cat.toLowerCase()) : 'A business';
  if (loc) return catPart + ' in ' + titleCase(loc);
  return catPart;
}

async function selectRows(supabase, withOptin) {
  var cols = 'job_id, result, input, business_fingerprint, version, created_at' + (withOptin ? ', leaderboard_optin' : '');
  return supabase
    .from('diagnostics')
    .select(cols)
    .eq('status', 'complete')
    .eq('paid', true)
    .not('result', 'is', null);
}

async function buildLeaderboard() {
  const supabase = getClient();

  // Try with the opt-in column; if it doesn't exist yet, fall back gracefully.
  let hasOptin = true;
  let { data, error } = await selectRows(supabase, true);
  if (error && /leaderboard_optin/.test(error.message || '')) {
    hasOptin = false;
    ({ data, error } = await selectRows(supabase, false));
  }
  if (error) throw new Error('Leaderboard query failed: ' + error.message);
  if (!data || !data.length) return { entries: [], sampleSize: 0 };

  // Keep only the latest version per business fingerprint.
  const latest = {};
  data.forEach(function (row) {
    const fp = row.business_fingerprint || row.job_id;
    if (!latest[fp] || (row.version || 1) > (latest[fp].version || 1)) latest[fp] = row;
  });

  const entries = Object.keys(latest).map(function (fp) {
    const row = latest[fp];
    const r = row.result || {};
    const inp = row.input || {};
    const score = Number(r.overallScore);
    if (!isFinite(score) || score < 0 || score > 100) return null;
    const category = r.inferredCategory || r.category || inp.category || '';
    const optedIn = hasOptin && row.leaderboard_optin === true;
    return {
      rank: 0,
      score: Math.round(score),
      category: String(category || '').toLowerCase(),
      // Named only with explicit opt-in; otherwise a safe anonymous label.
      label: optedIn && inp.name ? String(inp.name) : anonLabel(category, inp.city),
      named: !!(optedIn && inp.name)
    };
  }).filter(Boolean);

  entries.sort(function (a, b) { return b.score - a.score; });
  entries.forEach(function (e, i) { e.rank = i + 1; });

  return { entries: entries, sampleSize: entries.length };
}

async function getLeaderboard() {
  const now = Date.now();
  if (!cache || now - cacheAt > CACHE_TTL_MS) {
    cache = await buildLeaderboard();
    cacheAt = now;
  }
  return cache;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const params = event.queryStringParameters || {};
  let limit = parseInt(params.limit, 10);
  if (!isFinite(limit) || limit < 1) limit = 25;
  if (limit > 100) limit = 100;
  const category = (params.category || '').toLowerCase().trim();

  try {
    const board = await getLeaderboard();
    if (!board || board.sampleSize < MIN_BOARD_SIZE) {
      return json(200, { available: false, message: 'The leaderboard opens once enough businesses have run a full CHOIVE check.' });
    }
    let entries = board.entries;
    if (category) entries = entries.filter(function (e) { return e.category.indexOf(category) !== -1; });
    // Re-rank within the filtered view so ranks are 1..N.
    entries = entries.slice(0, limit).map(function (e, i) {
      return { rank: i + 1, score: e.score, label: e.label, category: e.category, named: e.named };
    });
    return json(200, { available: true, totalRanked: board.sampleSize, entries: entries });
  } catch (err) {
    console.error('get-leaderboard error:', err);
    return json(500, { error: 'Internal server error' });
  }
};
