// score-competitors.js
// CHOIVE™ — Real competitor scoring engine
// Takes up to 3 competitors already found in evidence and runs them through
// the full CHOIVE scoring model, returning their pillar scores for comparison.
// ENV: ANTHROPIC_API_KEY, SERPER_API_KEY

const { searchSerper } = require('./lib/serper');
const { fetchWebsiteText } = require('./lib/fetchWebsite');

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS      = 30000;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

async function scoreCompetitor(name, domain, category, city) {
  // Fetch light evidence for competitor
  var [serperData, websiteText] = await Promise.allSettled([
    searchSerper(name || domain, category, city),
    fetchWebsiteText('https://' + domain)
  ]);

  var searchText = serperData.status === 'fulfilled'
    ? (serperData.value.searchText || '') : '';
  var webText = websiteText.status === 'fulfilled'
    ? (websiteText.value || '').slice(0, 2000) : '';

  var prompt = 'You are CHOIVE™ — a business selection diagnostic engine.\n\n'
    + 'Score this competitor for AI recommendation visibility.\n\n'
    + 'Competitor: ' + (name || domain) + '\n'
    + 'Domain: ' + domain + '\n'
    + 'Category: ' + category + '\n'
    + 'Location: ' + (city || 'not specified') + '\n\n'
    + 'SEARCH EVIDENCE:\n' + searchText.slice(0, 3000) + '\n\n'
    + 'WEBSITE CONTENT:\n' + webText + '\n\n'
    + 'Score this business across four pillars (0-25 each).\n'
    + 'Be honest and evidence-based. Return ONLY valid JSON:\n'
    + '{\n'
    + '  "name": "' + (name || domain) + '",\n'
    + '  "domain": "' + domain + '",\n'
    + '  "overallScore": 0,\n'
    + '  "pillars": {\n'
    + '    "clarity":    { "score": 0, "finding": "one short phrase max 6 words" },\n'
    + '    "trust":      { "score": 0, "finding": "one short phrase max 6 words" },\n'
    + '    "difference": { "score": 0, "finding": "one short phrase max 6 words" },\n'
    + '    "ease":       { "score": 0, "finding": "one short phrase max 6 words" }\n'
    + '  },\n'
    + '  "strengthVsYou": "one sentence — what advantage does this competitor have",\n'
    + '  "weaknessVsYou": "one sentence — where are they vulnerable"\n'
    + '}';

  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);

  try {
    var res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    var data = await res.json();
    var text = (data.content || [])
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('').trim();

    var clean = text.replace(/```json|```/g, '').trim();
    var start = clean.indexOf('{');
    var end   = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    var parsed = JSON.parse(clean.slice(start, end + 1));
    parsed.overallScore = (
      (parsed.pillars.clarity.score    || 0) +
      (parsed.pillars.trust.score      || 0) +
      (parsed.pillars.difference.score || 0) +
      (parsed.pillars.ease.score       || 0)
    );
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    console.warn('[score-competitors] Failed for ' + domain + ':', err.message);
    return null;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  var competitors = body.competitors || [];
  var category    = String(body.category || '').trim();
  var city        = String(body.city     || '').trim();

  if (!competitors.length || !category) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing competitors or category' })
    };
  }

  // Score up to 3 competitors in parallel
  var toScore = competitors.slice(0, 3);
  var settled = await Promise.allSettled(
    toScore.map(function(c) {
      return scoreCompetitor(c.name || '', c.domain || '', category, city);
    })
  );

  var scored = settled
    .map(function(s) { return s.status === 'fulfilled' ? s.value : null; })
    .filter(Boolean)
    .sort(function(a, b) { return b.overallScore - a.overallScore; });

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ competitors: scored, scoredAt: new Date().toISOString() })
  };
};
