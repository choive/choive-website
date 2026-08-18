// get-category-benchmark.js
// Returns category benchmark statistics: median, mean, percentile rank for a given score
// Used to show "You scored 63 / Category avg: 51 / Top 18%" on results
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { realtime: { transport: ws } });
}

// Normalize category strings for matching — case-insensitive, collapse whitespace
function normalizeCategory(cat) {
  return String(cat || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// In-memory cache: { category: { median, mean, count, scores:[], updatedAt } }
// Refreshes every 6 hours or when cache is empty
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let categoryCache = {};
let lastCacheBuild = 0;

async function buildCategoryCache() {
  const supabase = getClient();
  
  // Fetch all complete, paid diagnostics with valid scores
  // Only paid diagnostics are included in benchmarks (ensures quality + prevents gaming)
  const { data, error } = await supabase
    .from('diagnostics')
    .select('result')
    .eq('status', 'complete')
    .eq('paid', true)
    .not('result', 'is', null);
  
  if (error) {
    console.error('get-category-benchmark: Supabase query failed:', error.message);
    throw new Error('Failed to fetch diagnostic data');
  }
  
  if (!data || data.length === 0) {
    console.warn('get-category-benchmark: No completed paid diagnostics found');
    return {};
  }
  
  // Group scores by normalized category
  const byCategory = {};
  
  data.forEach(row => {
    if (!row.result || typeof row.result !== 'object') return;
    const r = row.result;
    const score = Number(r.overallScore);
    const cat = normalizeCategory(r.inferredCategory || r.category || '');
    
    if (!cat || !isFinite(score) || score < 0 || score > 100) return;
    
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(score);
  });
  
  // Compute stats for each category (only if ≥5 data points for statistical validity)
  const cache = {};
  const MIN_SAMPLE_SIZE = 5;
  
  Object.keys(byCategory).forEach(cat => {
    const scores = byCategory[cat].sort((a, b) => a - b);
    if (scores.length < MIN_SAMPLE_SIZE) return; // Skip categories with <5 diagnostics
    
    const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    const median = scores.length % 2 === 0
      ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
      : scores[Math.floor(scores.length / 2)];
    
    cache[cat] = {
      median: Math.round(median),
      mean: Math.round(mean),
      count: scores.length,
      scores, // Keep sorted scores for percentile calculation
      updatedAt: Date.now()
    };
  });
  
  console.log(`get-category-benchmark: Built cache for ${Object.keys(cache).length} categories from ${data.length} diagnostics`);
  return cache;
}

async function getCategoryStats(category, userScore) {
  const now = Date.now();
  
  // Rebuild cache if stale or empty
  if (now - lastCacheBuild > CACHE_TTL_MS || Object.keys(categoryCache).length === 0) {
    console.log('get-category-benchmark: Cache stale or empty, rebuilding...');
    categoryCache = await buildCategoryCache();
    lastCacheBuild = now;
  }
  
  const normCat = normalizeCategory(category);
  const stats = categoryCache[normCat];
  
  if (!stats) {
    // Category not in cache (either <5 diagnostics or no match)
    return null;
  }
  
  // Calculate percentile rank if userScore is provided
  let percentile = null;
  if (isFinite(userScore)) {
    const scores = stats.scores;
    const countBelow = scores.filter(s => s < userScore).length;
    percentile = Math.round((countBelow / scores.length) * 100);
  }
  
  return {
    category: category, // Return original casing
    median: stats.median,
    mean: stats.mean,
    sampleSize: stats.count,
    percentile,
    updatedAt: stats.updatedAt
  };
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
  
  const params = event.queryStringParameters || {};
  const category = params.category || '';
  const score = params.score ? Number(params.score) : null;
  
  if (!category) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing category parameter' })
    };
  }
  
  try {
    const stats = await getCategoryStats(category, score);
    
    if (!stats) {
      // Not enough data for this category
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          available: false,
          message: 'Not enough data for this category yet'
        })
      };
    }
    
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        available: true,
        ...stats
      })
    };
  } catch (err) {
    console.error('get-category-benchmark error:', err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
