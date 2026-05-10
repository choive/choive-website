// lib/serper.js
// CHOIVE evidence collector — Serper multi-query
// ENV: SERPER_API_KEY

const SERPER_URL    = 'https://google.serper.dev/search';
const TIMEOUT_MS    = 8000;
const RESULTS_PER_Q = 5;

const PRIORITY_MAP = {
  reviews:    5,
  comparison: 5,
  reputation: 4,
  authority:  4,
  identity:   3
};

const DIRECTORY_DOMAINS = [
  'yelp.com', 'tripadvisor.com', 'trustpilot.com', 'yellowpages.com',
  'google.com', 'facebook.com', 'linkedin.com', 'youtube.com',
  'instagram.com', 'tiktok.com', 'reddit.com', 'twitter.com', 'x.com',
  'bbb.org', 'foursquare.com', 'angieslist.com', 'houzz.com'
];

const SOCIAL_DOMAINS = {
  instagram: 'instagram.com',
  tiktok:    'tiktok.com',
  facebook:  'facebook.com',
  linkedin:  'linkedin.com',
  youtube:   'youtube.com',
  twitter:   'twitter.com',
  reddit:    'reddit.com'
};

// ── Fetch single Serper query ─────────────────────────────────────────────────
async function fetchSerper(query) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: RESULTS_PER_Q }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn('Serper ' + res.status + ' for: ' + query); return null; }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    console.warn('Serper failed for "' + query + '": ' + err.message);
    return null;
  }
}

// ── Normalize domain ──────────────────────────────────────────────────────────
function normalizeUrl(url) {
  if (!url) return '';
  try {
    var u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}

// ── Classify signal type from query text ──────────────────────────────────────
function classifySignal(query) {
  var q = query.toLowerCase();
  if (/trustpilot|review|rating|customer/.test(q))     return { type: 'reviews',    priority: 5 };
  if (/best|top|alternative|competitor|vs /.test(q))   return { type: 'comparison', priority: 5 };
  if (/reddit|complaint|discussion|mention/.test(q))   return { type: 'reputation', priority: 4 };
  if (/news|press|linkedin|youtube|directory/.test(q)) return { type: 'authority',  priority: 4 };
  return                                                       { type: 'identity',   priority: 3 };
}

// ── Deduplicate by domain + title ─────────────────────────────────────────────
function deduplicate(results) {
  var seen = new Set();
  return results.filter(function(r) {
    var key = normalizeUrl(r.link || '') + '|' + (r.title || '').toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Detect social platforms from all results ──────────────────────────────────
function detectSocialSignals(allResults) {
  var signals = { instagram: false, tiktok: false, facebook: false, linkedin: false, youtube: false, twitter: false, reddit: false };
  for (var i = 0; i < allResults.length; i++) {
    var domain = normalizeUrl(allResults[i].link || '');
    var keys = Object.keys(SOCIAL_DOMAINS);
    for (var k = 0; k < keys.length; k++) {
      if (domain.includes(SOCIAL_DOMAINS[keys[k]])) signals[keys[k]] = true;
    }
  }
  return signals;
}

// ── Extract real competitors from comparison results ──────────────────────────
function extractCompetitors(queryResults, businessName) {
  var nameLower = (businessName || '').toLowerCase().replace(/\s+/g, '');
  var found = {};

  for (var i = 0; i < queryResults.length; i++) {
    var qr = queryResults[i];
    if (qr.signalType !== 'comparison') continue;
    for (var j = 0; j < qr.items.length; j++) {
      var item   = qr.items[j];
      var domain = normalizeUrl(item.link || '');
      if (!domain) continue;
      if (nameLower.length > 2 && domain.includes(nameLower)) continue;
      var isDir = false;
      for (var d = 0; d < DIRECTORY_DOMAINS.length; d++) {
        if (domain.includes(DIRECTORY_DOMAINS[d])) { isDir = true; break; }
      }
      if (isDir) continue;
      if (!found[domain]) found[domain] = { domain: domain, title: item.title || '', snippet: item.snippet || '', count: 0 };
      found[domain].count++;
    }
  }

  return Object.values(found).sort(function(a, b) { return b.count - a.count; }).slice(0, 3);
}

// ── Build simple summaries for Claude ────────────────────────────────────────
function buildSummaries(queryResults, competitors, socialSignals) {
  var reviewItems     = [];
  var reputationItems = [];
  var authorityItems  = [];

  for (var i = 0; i < queryResults.length; i++) {
    var qr = queryResults[i];
    for (var j = 0; j < qr.items.length; j++) {
      var item = qr.items[j];
      if (qr.signalType === 'reviews')    reviewItems.push(item.snippet);
      if (qr.signalType === 'reputation') reputationItems.push(item.snippet);
      if (qr.signalType === 'authority')  authorityItems.push(item.snippet);
    }
  }

  var reviewSummary = reviewItems.length > 0
    ? 'Found ' + reviewItems.length + ' review signal(s). Samples: ' + reviewItems.slice(0, 2).join(' | ')
    : 'No review signals found.';

  var reputationSummary = reputationItems.length > 0
    ? 'Found ' + reputationItems.length + ' reputation mention(s). Samples: ' + reputationItems.slice(0, 2).join(' | ')
    : 'No reputation mentions found.';

  var authoritySummary = authorityItems.length > 0
    ? 'Found ' + authorityItems.length + ' authority signal(s). Samples: ' + authorityItems.slice(0, 2).join(' | ')
    : 'No authority signals found.';

  var competitorSummary = competitors.length > 0
    ? 'Top competitors appearing in search: ' + competitors.map(function(c) { return c.domain; }).join(', ')
    : 'No clear competitors identified in search results.';

  var socialList = Object.keys(socialSignals).filter(function(k) { return socialSignals[k]; });
  var socialStr  = socialList.length > 0 ? 'Social presence detected on: ' + socialList.join(', ') : 'No social presence detected in search results.';

  return {
    reviewSummary:     reviewSummary,
    reputationSummary: reputationSummary,
    authoritySummary:  authoritySummary,
    competitorSummary: competitorSummary,
    socialSummary:     socialStr
  };
}

// ── Build grouped searchText for Claude ───────────────────────────────────────
function buildSearchText(queryResults) {
  var ORDER  = ['reviews', 'comparison', 'reputation', 'authority', 'identity'];
  var LABELS = {
    reviews:    '=== REVIEW & RATING SIGNALS ===',
    comparison: '=== COMPARISON & COMPETITOR SIGNALS ===',
    reputation: '=== REPUTATION & MENTION SIGNALS ===',
    authority:  '=== AUTHORITY & PRESS SIGNALS ===',
    identity:   '=== IDENTITY & PRESENCE SIGNALS ==='
  };

  var grouped = {};
  for (var i = 0; i < queryResults.length; i++) {
    var sig = queryResults[i].signalType || 'identity';
    if (!grouped[sig]) grouped[sig] = [];
    grouped[sig].push(queryResults[i]);
  }

  var lines = [];
  for (var s = 0; s < ORDER.length; s++) {
    var sigType = ORDER[s];
    if (!grouped[sigType] || grouped[sigType].length === 0) continue;
    lines.push('\n' + LABELS[sigType]);
    for (var g = 0; g < grouped[sigType].length; g++) {
      var grp = grouped[sigType][g];
      if (!grp.items || grp.items.length === 0) continue;
      lines.push('\nQUERY: ' + grp.query);
      for (var k = 0; k < grp.items.length; k++) {
        var r = grp.items[k];
        lines.push((k + 1) + '. ' + (r.title || '') + ' — ' + (r.snippet || '') + ' — ' + (r.link || ''));
      }
    }
  }
  return lines.join('\n');
}

// ── Build kgText ──────────────────────────────────────────────────────────────
function buildKgText(kg) {
  if (!kg) return '';
  var parts = [];
  if (kg.title)       parts.push('Name: '        + kg.title);
  if (kg.type)        parts.push('Type: '         + kg.type);
  if (kg.description) parts.push('Description: '  + kg.description);
  if (kg.website)     parts.push('Website: '      + kg.website);
  if (kg.rating)      parts.push('Rating: '       + kg.rating);
  if (kg.reviewCount) parts.push('Reviews: '      + kg.reviewCount);
  if (kg.address)     parts.push('Address: '      + kg.address);
  return parts.join('\n');
}

// ── Infer official website ────────────────────────────────────────────────────
function inferOfficialSite(website, serperPayload, name) {
  if (website && website.trim()) return normalizeUrl(website.trim());
  var kg = serperPayload && serperPayload.knowledgeGraph;
  if (kg && kg.website) return normalizeUrl(kg.website);
  var nameLower = (name || '').toLowerCase().replace(/\s+/g, '');
  var results   = (serperPayload && serperPayload.results) || [];
  for (var i = 0; i < results.length; i++) {
    var domain = normalizeUrl(results[i].link || '');
    if (domain && nameLower.length > 3 && domain.includes(nameLower)) return domain;
  }
  return results.length > 0 ? normalizeUrl(results[0].link || '') : '';
}

// ── Main search function ──────────────────────────────────────────────────────
async function searchSerper(name, category, city) {
  var queries = [
    // Identity
    { q: name + ' ' + city,                                    type: 'identity'   },
    { q: name + ' ' + category,                                type: 'identity'   },
    { q: name + ' official website',                           type: 'identity'   },
    // Reviews
    { q: name + ' reviews',                                    type: 'reviews'    },
    { q: name + ' site:trustpilot.com',                        type: 'reviews'    },
    { q: name + ' site:g2.com',                                type: 'reviews'    },
    { q: name + ' site:glassdoor.com',                         type: 'reviews'    },
    { q: name + ' customer reviews rating',                    type: 'reviews'    },
    // Reputation
    { q: name + ' site:reddit.com',                            type: 'reputation' },
    { q: name + ' complaints OR problems OR issues',           type: 'reputation' },
    // Authority
    { q: name + ' news OR press OR announcement',              type: 'authority'  },
    { q: name + ' site:linkedin.com',                          type: 'authority'  },
    { q: name + ' site:youtube.com',                           type: 'authority'  },
    // Comparison
    { q: 'best ' + category + ' ' + city,                      type: 'comparison' },
    { q: 'top ' + category + ' ' + city,                       type: 'comparison' },
    { q: category + ' software comparison ' + city,            type: 'comparison' },
    { q: name + ' vs OR alternative OR competitor',            type: 'competition'},
    { q: category + ' alternatives ' + city,                   type: 'comparison' }
  ];

  var settled = await Promise.allSettled(
    queries.map(function(item) { return fetchSerper(item.q); })
  );

  var knowledgeGraph = null;
  var queryResults   = [];
  var allResults     = [];

  for (var i = 0; i < settled.length; i++) {
    if (settled[i].status !== 'fulfilled' || !settled[i].value) continue;
    var data     = settled[i].value;
    var queryDef = queries[i];

    if (!knowledgeGraph && data.knowledgeGraph) knowledgeGraph = data.knowledgeGraph;

    // Use manual type first, fall back to classifier
    var sig        = classifySignal(queryDef.q);
    var signalType = queryDef.type || sig.type;
    var priority   = PRIORITY_MAP[signalType] || sig.priority;

    var items = [];
    var orgs  = data.organic || [];
    for (var j = 0; j < orgs.length; j++) {
      var item = {
        position:    j + 1,
        title:       orgs[j].title   || '',
        snippet:     orgs[j].snippet || '',
        link:        orgs[j].link    || '',
        sourceQuery: queryDef.q,
        signalType:  signalType,
        priority:    priority
      };
      items.push(item);
      allResults.push(item);
    }
    queryResults.push({ query: queryDef.q, signalType: signalType, items: items });
  }

  var results      = deduplicate(allResults).sort(function(a, b) {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.position - b.position;
  });
  var competitors  = extractCompetitors(queryResults, name);
  var socialSignals = detectSocialSignals(allResults);
  var summaries    = buildSummaries(queryResults, competitors, socialSignals);
  var searchText   = buildSearchText(queryResults);
  var kgText       = buildKgText(knowledgeGraph);

  return {
    results:       results,
    knowledgeGraph: knowledgeGraph,
    searchText:    searchText,
    kgText:        kgText,
    competitors:   competitors,
    socialSignals: socialSignals,
    summaries:     summaries
  };
}

module.exports = {
  searchSerper:      searchSerper,
  inferOfficialSite: inferOfficialSite,
  normalizeUrl:      normalizeUrl
};
