// lib/serper.js
// CHOIVE evidence collector — Serper multi-query
// ENV: SERPER_API_KEY
 
const SERPER_URL    = 'https://google.serper.dev/search';
const TIMEOUT_MS    = 8000;
const RESULTS_PER_Q = 5;
 
const PRIORITY_MAP = {
  reviews:    5,
  comparison: 5,
  community:  5, // real buyer conversations already happening \u2014 the exact
                 // tactical evidence actions need; must never be silently
                 // deprioritized behind generic comparison/reputation results
  reputation: 4,
  authority:  4,
  identity:   3
};
 
const DIRECTORY_DOMAINS = [
  // Social platforms
  'yelp.com', 'tripadvisor.com', 'trustpilot.com', 'yellowpages.com',
  'google.com', 'facebook.com', 'linkedin.com', 'youtube.com',
  'instagram.com', 'tiktok.com', 'reddit.com', 'twitter.com', 'x.com',
  // Software directories and review aggregators
  'slashdot.org', 'sourceforge.net', 'capterra.com', 'g2.com',
  'getapp.com', 'softwareadvice.com', 'techradar.com', 'pcmag.com',
  'cnet.com', 'techcrunch.com', 'venturebeat.com', 'forbes.com',
  'businessinsider.com', 'gartner.com', 'forrester.com',
  // Industry blogs and news
  'mediaentertainmentbusinessreview.com', 'sportspromedia.com',
  'streamingmedia.com', 'rapid-tv-news.com', 'broadcastnow.co.uk',
  'advanced-television.com', 'digitaltveurope.com',
  // Generic directories
  'bbb.org', 'foursquare.com', 'angieslist.com', 'houzz.com',
  'clutch.co', 'goodfirms.co',
  'alternativeto.net', 'comparably.com', 'glassdoor.com', 'indeed.com',
  'wikipedia.org', 'wikimedia.org', 'wikidata.org',
  // Business registry, company data, and commercial databases
  // These are data aggregators — never real competitors
  'companydata.com', 'ensun.io', 'handelsregister.ai', 'handelsregister.de',
  'northdata.de', 'northdata.com', 'firmenwissen.de', 'unternehmensregister.de',
  'bundesanzeiger.de', 'creditreform.de', 'dnb.com', 'dun-bradstreet.com',
  'crunchbase.com', 'pitchbook.com', 'owler.com', 'zoominfo.com', 'credenceresearch.com',
  'grandviewresearch.com', 'mordorintelligence.com', 'marketsandmarkets.com', 'statista.com',
  'ibisworld.com', 'euromonitor.com', 'mintel.com', 'spglobal.com', 'indexbox.io',
  'similarsites.com', 'similarweb.com', 'semrush.com', 'ahrefs.com',
  'builtwith.com', 'wappalyzer.com', 'datanyze.com',
  // Food/recipe/taste content sites — not beef brands
  'tasteatlas.com', 'allrecipes.com', 'bbcgoodfood.com', 'seriouseats.com',
  'epicurious.com', 'chefkoch.de', 'eat.de', 'kochbar.de',
  // General business/legal directories
  'companies-house.gov.uk', 'opencorporates.com', 'gleif.org',
  'sec.gov', 'europages.com', 'kompass.com', 'wlw.de', 'wer-liefert-was.de',
  'unternehmensverzeichnis.org', 'gelbeseiten.de', 'dasoertliche.de'
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
async function fetchSerper(query, isRetry) {
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
    if (!res.ok) {
      // 429 (rate limit) is transient and typically clears within a second or
      // two \u2014 confirmed live: a whole diagnostic's worth of competitor
      // queries can burst-trigger it together. One short-delay retry recovers
      // most of these instead of silently losing the search evidence entirely
      // (which was forcing the selection stage into its noisier fallback path
      // more often than necessary). Other error codes are not retried \u2014
      // they're not transient in the same way.
      if (res.status === 429 && !isRetry) {
        console.warn('Serper 429 for: ' + query + ' \u2014 retrying once after backoff');
        await new Promise(function(r) { setTimeout(r, 800 + Math.random() * 400); });
        return fetchSerper(query, true);
      }
      console.warn('Serper ' + res.status + ' for: ' + query);
      return null;
    }
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
    if (qr.signalType !== 'comparison' && qr.signalType !== 'named_competitor') continue;
    for (var j = 0; j < qr.items.length; j++) {
      var item   = qr.items[j];
      var domain = normalizeUrl(item.link || '');
      if (!domain) continue;

      // Never include the business itself
      if (nameLower.length > 2 && domain.includes(nameLower)) continue;

      // Never include directories or review aggregators
      var isDir = false;
      for (var d = 0; d < DIRECTORY_DOMAINS.length; d++) {
        if (domain.includes(DIRECTORY_DOMAINS[d])) { isDir = true; break; }
      }
      if (isDir) continue;

      if (!found[domain]) {
        found[domain] = {
          domain:  domain,
          title:   item.title   || '',
          snippet: item.snippet || '',
          count:   0,
          isLocal: qr.isLocal   || false
        };
      }

      // Weight by source quality so noise from generic listicles
      // does not beat a real competitor named in press or by the owner
      var weight = 1;
      if (qr.signalType === 'named_competitor') {
        // Owner-verified — highest possible trust
        weight = 20;
      } else if (/techcrunch|forbes|venturebeat|wired|ft\.com|bloomberg|reuters|wsj\.com|theverge/.test(domain)) {
        // Press source — real industry naming
        weight = 8;
      } else if (/best|top|alternative|vs/.test((item.title || '').toLowerCase())) {
        // Generic listicle — low signal
        weight = 2;
      }

      found[domain].count += weight;
    }
  }

  return Object.values(found)
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, 5);
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
  // 'community' placed FIRST \u2014 real, already-happening buyer conversations
  // are the most actionable evidence a report can have, and this category
  // was previously invisible: correctly gathered and typed, but silently
  // dropped here because it was missing from ORDER \u2014 it was computed and
  // then never once reached the model, on every single run.
  var ORDER  = ['community', 'reviews', 'comparison', 'reputation', 'authority', 'identity'];
  var LABELS = {
    community:  '=== REAL BUYER CONVERSATIONS (community threads to join, not just monitor) ===',
    reviews:    '=== REVIEW & RATING SIGNALS ===',
    comparison: '=== COMPARISON & COMPETITOR SIGNALS ===',
    reputation: '=== REPUTATION & MENTION SIGNALS ===',
    authority:  '=== AUTHORITY & PRESS SIGNALS ===',
    identity:   '=== IDENTITY & PRESENCE SIGNALS ==='
  };
 
  var grouped = {};
  for (var i = 0; i < queryResults.length; i++) {
    var sig = queryResults[i].signalType || 'identity';
    if (sig === 'named_competitor') sig = 'comparison';
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
    // Reputation \u2014 monitoring: does the business ALREADY have a presence
    { q: name + ' site:reddit.com',                            type: 'reputation' },
    { q: name + ' complaints OR problems OR issues',           type: 'reputation' },
    // Community opportunity \u2014 DIFFERENT from the above: not "is the business
    // already mentioned," but "where are real buyers already asking this
    // category's question right now" \u2014 the actionable threads a business
    // could genuinely join. Without this, actions can only ever recommend
    // institutional fixes (schema, review platforms), never tactical,
    // human engagement in a conversation that's already happening.
    { q: 'best ' + category + ' ' + city + ' site:reddit.com',  type: 'community'  },
    { q: category + ' recommendation site:reddit.com',         type: 'community'  },
    { q: 'best ' + category + ' forum OR group',                type: 'community'  },
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
 
// ── Second-pass competitor search using inferred category ─────────────────────
// knownCompetitors (optional): comma/semicolon-separated names the business owner
// provided directly. This is verified ground truth, so we run real targeted
// searches for each one instead of only hoping generic category queries surface
// the same names. Matches from these named searches are boosted to the top.
async function searchCompetitors(name, inferredCategory, city, knownCompetitors) {
  if (!inferredCategory) return { results: [], searchText: '' };
 
  // Extract short keyword from inferred category for effective search queries
  // e.g. "B2B OTT middleware platform for telcos" → "OTT middleware platform"
  var catWords = inferredCategory.replace(/^b2b\s+/i, '').replace(/\s+for\s+.+$/i, '').trim();
  // Cap at 5 words to keep queries effective
  var catShort = catWords.split(' ').slice(0, 5).join(' ');
 
  // MARKET ANCHOR: city was accepted as a parameter but never actually used
  // in query construction \u2014 every search here ran market-agnostic regardless
  // of the business's real location. This silently biased results toward
  // whatever content dominates generic search (often US-heavy), independent
  // of and unrelated to whichever language the AI-simulation portion uses.
  // Confirmed live: an English-language Taurbull test returned an all-US
  // competitor list even though Taurbull only serves Germany \u2014 because
  // NOTHING in this search was ever anchored to Germany to begin with.
  var marketSuffix = city ? ' ' + city : '';
  var queries = [
    // Direct competitor intent — most reliable signal
    { q: 'who competes with ' + name,                                type: 'competition' },
    { q: name + ' vs',                                               type: 'competition' },
    { q: name + ' alternative' + marketSuffix,                       type: 'competition' },
    { q: name + ' competitors' + marketSuffix,                       type: 'competition' },
    // Category-level — real businesses not platforms — MARKET-ANCHORED so
    // the candidate pool reflects the business's actual serviceable market,
    // regardless of the AI-simulation language choice.
    { q: catShort + ' companies' + marketSuffix,                     type: 'comparison'  },
    { q: catShort + ' startups' + marketSuffix,                      type: 'comparison'  },
    { q: 'best ' + catShort + marketSuffix,                          type: 'comparison'  },
    // Press and industry — surfaces real named players
    { q: name + ' news OR press OR announcement',                    type: 'comparison'  },
    { q: catShort + ' industry players' + marketSuffix,              type: 'comparison'  },
    // Category-first brand searches — find market leaders independently of how
    // the subject describes itself. Uses both English and German so businesses
    // like Taurbull (Germany, German category) surface brands like Otto Gourmet
    // that dominate category-level searches even when they never appear in
    // subject-anchored queries ("who competes with Taurbull").
    { q: 'best ' + catShort + ' brand' + marketSuffix,              type: 'comparison'  },
    { q: 'top ' + catShort + ' brands' + marketSuffix,              type: 'comparison'  },
    { q: catShort + ' Marke' + marketSuffix,                        type: 'comparison'  },
    { q: catShort + ' Hersteller' + marketSuffix,                   type: 'comparison'  },
    // RESTORED \u2014 present in an earlier version of this file, absent from
    // what was actually live when this session began (a prior deploy appears
    // to have been silently overwritten by an older version somewhere before
    // today). These surface real, human, contextual evidence \u2014 industry
    // events, partnerships, press \u2014 that generic "best X" listicle queries
    // miss, and are a genuine, different kind of evidence than the community
    // buyer-conversation queries added above them.
    { q: name + ' industry panel OR conference OR webinar',          type: 'comparison'  },
    { q: name + ' partnership OR announcement OR news',              type: 'comparison'  }
  ];
  // If the user named specific competitors, search each one directly — this is
  // verified ground truth from the business owner, not a guess, so it deserves
  // real targeted searches rather than hoping generic category queries surface
  // the same names by chance.
  if (knownCompetitors && typeof knownCompetitors === 'string' && knownCompetitors.trim()) {
    var namedList = knownCompetitors.split(/[,;]/).map(function(s) { return s.trim(); }).filter(Boolean).slice(0, 3);
    namedList.forEach(function(compName) {
      queries.push({ q: compName + ' ' + catShort,        type: 'named_competitor' });
      queries.push({ q: compName + ' vs ' + name,         type: 'named_competitor' });
    });
  }
 
  // Stagger the burst slightly \u2014 with plenty of Serper credit remaining
  // but real 429s occurring, this is pure concurrency (too many requests in
  // the same instant), not quota exhaustion. A small, cheap stagger reduces
  // how often the rate limit fires at all, complementing the retry-on-429
  // logic in fetchSerper (which handles whatever still slips through).
  var settled = await Promise.allSettled(
    queries.map(function(item, i) {
      return new Promise(function(resolve) {
        setTimeout(function() { resolve(fetchSerper(item.q)); }, i * 120);
      });
    })
  );
 
  var queryResults = [];
  var allResults   = [];
 
  for (var i = 0; i < settled.length; i++) {
    if (settled[i].status !== 'fulfilled' || !settled[i].value) continue;
    var data     = settled[i].value;
    var queryDef = queries[i];
    var sig      = classifySignal(queryDef.q);
    var signalType = queryDef.type || sig.type;
    var priority   = queryDef.type === 'named_competitor' ? 100 : (PRIORITY_MAP[signalType] || sig.priority);
 
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
 
  var results     = deduplicate(allResults).sort(function(a, b) {
    return b.priority !== a.priority ? b.priority - a.priority : a.position - b.position;
  });
  var competitors = extractCompetitors(queryResults, name);
  var searchText  = buildSearchText(queryResults);
 
  return { results: results, competitors: competitors, searchText: searchText };
}
 
// ── ONLINE CHANNEL COMPETITOR SEARCH ─────────────────────────────────────────
// Used only when dual-arena is detected. Runs targeted "buy X online" queries
// to surface the established DTC/e-commerce player in the subject's product
// category and market — a different question from "who competes with [name]".
async function searchOnlineChannelCompetitor(productType, market) {
  if (!productType) return { competitors: [], searchText: '' };
  // Strip channel-descriptor prefixes and location suffixes that make poor search queries
  // e.g. "Direct-to-consumer premium grass-fed beef delivery — Germany" → "premium grass-fed beef delivery"
  var STRIP_PREFIX = /^(direct[\s-]to[\s-]consumer|dtc|b2c|online|e[\s-]commerce|subscription)\s+/i;
  var STRIP_SUFFIX = /\s*[—–\-]+\s*[A-Z][^—–\-]*$/;   // strips "— Germany" style location tags
  var cleaned = productType
    .replace(STRIP_SUFFIX, '')
    .replace(STRIP_PREFIX, '').replace(STRIP_PREFIX, '')
    .trim();
  var catShort = cleaned.split(/\s+/).slice(0, 5).join(' ');
  var mkt = market ? ' ' + market : '';

  var queries = [
    { q: 'buy ' + catShort + ' online' + mkt,             type: 'comparison' },
    { q: 'order ' + catShort + ' online delivery' + mkt,  type: 'comparison' },
    { q: 'online ' + catShort + ' shop' + mkt,            type: 'comparison' },
    { q: 'best online ' + catShort + mkt,                  type: 'comparison' },
    { q: catShort + ' home delivery' + mkt,                type: 'comparison' },
    { q: catShort + ' direct to consumer' + mkt,          type: 'comparison' },
  ];

  var settled = await Promise.allSettled(
    queries.map(function(item, i) {
      return new Promise(function(resolve) {
        setTimeout(function() { resolve(fetchSerper(item.q)); }, i * 120);
      });
    })
  );

  var queryResults = [];
  for (var i = 0; i < settled.length; i++) {
    if (settled[i].status !== 'fulfilled' || !settled[i].value) continue;
    var data  = settled[i].value;
    var qDef  = queries[i];
    var items = (data.organic || []).map(function(r, j) {
      return {
        position:    j + 1,
        title:       r.title   || '',
        snippet:     r.snippet || '',
        link:        r.link    || '',
        sourceQuery: qDef.q,
        signalType:  'comparison',
        priority:    5
      };
    });
    queryResults.push({ query: qDef.q, signalType: 'comparison', items: items });
  }

  return {
    competitors: extractCompetitors(queryResults, '').slice(0, 6),
    searchText:  buildSearchText(queryResults)
  };
}

module.exports = {
  searchSerper:                   searchSerper,
  searchCompetitors:              searchCompetitors,
  searchOnlineChannelCompetitor:  searchOnlineChannelCompetitor,
  inferOfficialSite:              inferOfficialSite,
  normalizeUrl:                   normalizeUrl
};
