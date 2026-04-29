// lib/serper.js
// Multi-query Serper search for CHOIVE evidence collection
// ENV: SERPER_API_KEY

const SERPER_URL    = 'https://google.serper.dev/search';
const TIMEOUT_MS    = 9000;
const RESULTS_PER_Q = 5;

// ── HTTP fetch with timeout ───────────────────────────────────────────────────
async function fetchSerper(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': process.env.SERPER_API_KEY
      },
      body: JSON.stringify({ q: query, num: RESULTS_PER_Q }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`Serper non-200 for "${query}": ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      console.warn(`Serper timeout for "${query}"`);
    } else {
      console.warn(`Serper error for "${query}":`, err.message);
    }
    return null;
  }
}

// ── Normalize URL to domain for deduplication ─────────────────────────────────
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}

// ── Classify signal type from query ──────────────────────────────────────────
function classifySignal(query) {
  const q = query.toLowerCase();
  if (/best|providers|top/.test(q))   return { signalType: 'comparison',  priority: 5 };
  if (/competitors/.test(q))          return { signalType: 'competition', priority: 5 };
  if (/reviews/.test(q))              return { signalType: 'reviews',     priority: 4 };
  if (/linkedin|press/.test(q))       return { signalType: 'authority',   priority: 2 };
  return                                     { signalType: 'identity',    priority: 3 };
}

// ── Deduplicate results by domain + title ─────────────────────────────────────
function deduplicate(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = normalizeUrl(r.link) + '|' + (r.title || '').toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Format results block grouped by signal type ───────────────────────────────
function formatResultsBlock(queryResults) {
  const SIGNAL_ORDER  = ['comparison', 'competition', 'reviews', 'identity', 'authority'];
  const SIGNAL_LABELS = {
    comparison:  '=== COMPARISON SIGNALS ===',
    competition: '=== COMPETITION SIGNALS ===',
    reviews:     '=== REVIEW SIGNALS ===',
    identity:    '=== IDENTITY SIGNALS ===',
    authority:   '=== AUTHORITY SIGNALS ==='
  };

  // Group queryResults by signalType
  const grouped = {};
  for (const { query, items } of queryResults) {
    if (!items || items.length === 0) continue;
    const sig = classifySignal(query).signalType;
    if (!grouped[sig]) grouped[sig] = [];
    grouped[sig].push({ query, items });
  }

  const lines = [];
  for (const sig of SIGNAL_ORDER) {
    if (!grouped[sig]) continue;
    lines.push(`\n${SIGNAL_LABELS[sig]}`);
    for (const { query, items } of grouped[sig]) {
      lines.push(`\nQUERY: ${query}`);
      items.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title || 'No title'} — ${r.snippet || 'No snippet'} — ${r.link || ''}`);
      });
    }
  }
  return lines.join('\n');
}

// ── Main search function ──────────────────────────────────────────────────────
async function searchSerper(name, category, city) {
  const queries = [
    `${name} ${city}`,
    `${name} ${category}`,
    `${name} official website`,
    `${category} ${city}`,
    `best ${category} ${city}`,
    `${category} providers ${city}`,
    `${name} reviews`,
    `${name} LinkedIn`,
    `${name} press`,
    `${name} competitors`
  ];

  // Run all queries in parallel — one failure does not kill the rest
  const settled = await Promise.allSettled(queries.map(q => fetchSerper(q)));

  let knowledgeGraph = null;
  const queryResults = [];
  const allResults   = [];

  settled.forEach((outcome, i) => {
    if (outcome.status !== 'fulfilled' || !outcome.value) return;
    const data  = outcome.value;
    const query = queries[i];

    // Capture first knowledge graph found
    if (!knowledgeGraph && data.knowledgeGraph) {
      knowledgeGraph = data.knowledgeGraph;
    }

    const signal = classifySignal(query);
    const items = (data.organic || []).map((r, idx) => ({
      position:    idx + 1,
      title:       r.title   || '',
      snippet:     r.snippet || '',
      link:        r.link    || '',
      sourceQuery: query,
      signalType:  signal.signalType,
      priority:    signal.priority
    }));

    queryResults.push({ query, items });
    allResults.push(...items);
  });

  // Deduplicated flat list — sorted by priority DESC, position ASC
  const results = deduplicate(allResults).sort((a, b) =>
    b.priority !== a.priority ? b.priority - a.priority : a.position - b.position
  );

  // Formatted text block for Claude prompt
  const searchText = formatResultsBlock(queryResults);

  // Knowledge graph text
  const kgText = knowledgeGraph
    ? `Title: ${knowledgeGraph.title || ''}\nType: ${knowledgeGraph.type || ''}\nDescription: ${knowledgeGraph.description || ''}\nWebsite: ${knowledgeGraph.website || ''}\nRating: ${knowledgeGraph.rating || ''}`
    : '';

  return { results, knowledgeGraph, searchText, kgText };
}

// ── inferOfficialSite ─────────────────────────────────────────────────────────
// Returns the most likely official domain for the business
function inferOfficialSite(website, serperPayload, name) {
  if (website && website.trim()) {
    return website.trim();
  }

  const knowledgeGraph = serperPayload?.knowledgeGraph || null;
  const results = serperPayload?.results || [];

  if (knowledgeGraph?.website) {
    return knowledgeGraph.website;
  }

  const normalizedName = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const matched = results.find(result => {
    const domain = normalizeUrl(result.link);
    const flatDomain = domain.replace(/[^a-z0-9]/g, '');
    return normalizedName && flatDomain.includes(normalizedName);
  });

  return matched?.link || results[0]?.link || '';
}
async function searchSerper(name, category, city) {
  if (!process.env.SERPER_API_KEY) {
    throw new Error('Missing SERPER_API_KEY');
  }
module.exports = { searchSerper, inferOfficialSite, normalizeUrl };
