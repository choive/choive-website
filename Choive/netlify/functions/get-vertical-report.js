// get-vertical-report.js
// Returns the annual vertical benchmark report: for each business category (vertical)
// with enough data, it reports how many businesses were measured, the average and
// median CHOIVE Index score, a simple score distribution, and the "most common
// weakness" (the pillar with the lowest average score across that vertical).
//
// All numbers come from REAL completed + paid diagnostics only. Nothing is made up.
// When a vertical has too little data, it is left out (honest, not padded).
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

// Normalize category strings for grouping — case-insensitive, collapse whitespace
function normalizeCategory(cat) {
  return String(cat || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Turn a normalized key back into a readable Title Case label
function titleCase(s) {
  return String(s || '')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const PILLAR_KEYS = ['clarity', 'trust', 'difference', 'ease'];
const PILLAR_LABELS = {
  clarity: 'Clarity',
  trust: 'Trust',
  difference: 'Difference',
  ease: 'Ease'
};

// In-memory cache of the whole report. Rebuilt every 6 hours.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_SAMPLE_SIZE = 5; // A vertical needs at least 5 businesses to be shown
let reportCache = null;
let lastCacheBuild = 0;

function median(sortedNums) {
  const n = sortedNums.length;
  if (n === 0) return 0;
  return n % 2 === 0
    ? (sortedNums[n / 2 - 1] + sortedNums[n / 2]) / 2
    : sortedNums[Math.floor(n / 2)];
}

async function buildReport() {
  const supabase = getClient();

  // Only completed, paid diagnostics with a real result are counted.
  // We also read business_fingerprint + version so we can keep just the
  // latest run per business (so re-runs don't count the same business twice).
  const { data, error } = await supabase
    .from('diagnostics')
    .select('result, business_fingerprint, version, created_at')
    .eq('status', 'complete')
    .eq('paid', true)
    .not('result', 'is', null);

  if (error) {
    console.error('get-vertical-report: Supabase query failed:', error.message);
    throw new Error('Failed to fetch diagnostic data');
  }

  if (!data || data.length === 0) {
    console.warn('get-vertical-report: No completed paid diagnostics found');
    return { verticals: [], totalBusinesses: 0, generatedAt: Date.now() };
  }

  // Keep only the latest version per business fingerprint (dedupe re-runs).
  const latestByFingerprint = {};
  data.forEach(row => {
    const fp = row.business_fingerprint || (`__nofp_${Math.random()}`); // rows w/o fp stay unique
    const ver = Number(row.version) || 0;
    const existing = latestByFingerprint[fp];
    if (!existing || ver > (Number(existing.version) || 0)) {
      latestByFingerprint[fp] = row;
    }
  });
  const rows = Object.values(latestByFingerprint);

  // Group by normalized vertical
  const byVertical = {};
  rows.forEach(row => {
    const r = row.result;
    if (!r || typeof r !== 'object') return;

    const score = Number(r.overallScore);
    if (!isFinite(score) || score < 0 || score > 100) return;

    const key = normalizeCategory(r.inferredCategory || r.category || '');
    if (!key) return;

    if (!byVertical[key]) {
      byVertical[key] = { scores: [], pillarSums: { clarity: 0, trust: 0, difference: 0, ease: 0 }, pillarCounts: { clarity: 0, trust: 0, difference: 0, ease: 0 } };
    }
    byVertical[key].scores.push(score);

    // Accumulate pillar scores (each 0-25) to find the weakest pillar for the vertical
    const pillars = (r.pillars && typeof r.pillars === 'object') ? r.pillars : {};
    PILLAR_KEYS.forEach(pk => {
      const pv = pillars[pk];
      const ps = pv && isFinite(Number(pv.score)) ? Number(pv.score) : null;
      if (ps !== null && ps >= 0 && ps <= 25) {
        byVertical[key].pillarSums[pk] += ps;
        byVertical[key].pillarCounts[pk] += 1;
      }
    });
  });

  // Build the report list, keeping only verticals with enough data
  const verticals = [];
  Object.keys(byVertical).forEach(key => {
    const bucket = byVertical[key];
    const scores = bucket.scores.slice().sort((a, b) => a - b);
    if (scores.length < MIN_SAMPLE_SIZE) return;

    const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;

    // Simple score distribution buckets (out of 100)
    const distribution = { low: 0, mid: 0, high: 0 }; // 0-39, 40-69, 70-100
    scores.forEach(s => {
      if (s < 40) distribution.low += 1;
      else if (s < 70) distribution.mid += 1;
      else distribution.high += 1;
    });

    // Find the weakest pillar = lowest average pillar score in this vertical
    let weakestPillar = null;
    let weakestAvg = Infinity;
    const pillarAverages = {};
    PILLAR_KEYS.forEach(pk => {
      const cnt = bucket.pillarCounts[pk];
      if (cnt > 0) {
        const avg = bucket.pillarSums[pk] / cnt;
        pillarAverages[pk] = Math.round(avg * 10) / 10; // one decimal, out of 25
        if (avg < weakestAvg) {
          weakestAvg = avg;
          weakestPillar = pk;
        }
      }
    });

    verticals.push({
      vertical: titleCase(key),
      businessesMeasured: scores.length,
      averageScore: Math.round(mean),
      medianScore: Math.round(median(scores)),
      distribution,
      pillarAverages, // each out of 25
      commonWeakness: weakestPillar ? PILLAR_LABELS[weakestPillar] : null
    });
  });

  // Sort verticals by how many businesses were measured (most first)
  verticals.sort((a, b) => b.businessesMeasured - a.businessesMeasured);

  const totalBusinesses = verticals.reduce((sum, v) => sum + v.businessesMeasured, 0);

  console.log(`get-vertical-report: Built report for ${verticals.length} verticals from ${rows.length} unique businesses`);
  return { verticals, totalBusinesses, generatedAt: Date.now() };
}

async function getReport() {
  const now = Date.now();
  if (!reportCache || now - lastCacheBuild > CACHE_TTL_MS) {
    console.log('get-vertical-report: Cache stale or empty, rebuilding...');
    reportCache = await buildReport();
    lastCacheBuild = now;
  }
  return reportCache;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  try {
    const report = await getReport();

    // Honest empty state: not enough data anywhere yet
    if (!report.verticals || report.verticals.length === 0) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          available: false,
          message: 'Not enough data yet to publish a benchmark report.',
          minSampleSize: MIN_SAMPLE_SIZE
        })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        available: true,
        minSampleSize: MIN_SAMPLE_SIZE,
        ...report
      })
    };
  } catch (err) {
    console.error('get-vertical-report error:', err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
