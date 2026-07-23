// lib/fetchWebsite.js
// CHOIVE website evidence extractor
// Fetches homepage + about page, extracts schema, meta, H1/H2, OG tags
// Also fetches competitor homepage for comparison
//
// CHANGE FROM PREVIOUS VERSION:
// fetchWebsiteText() now returns { text, signals } instead of just a string.
// `signals` contains every structured fact already extracted — boolean/string,
// not prose — so the engine can use them directly without Claude re-interpreting.
// All other exports are unchanged.

const TIMEOUT_MS      = 8000;
const LLMS_TIMEOUT_MS = 5000;
const MAX_CHARS_PAGE  = 3000;
const MAX_CHARS_COMP  = 2000;

// ── Safe fetch with timeout ───────────────────────────────────────────────────
async function safeFetch(url, maxChars) {
  if (!url) return '';
  var safeUrl = url.startsWith('http') ? url : 'https://' + url;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetch(safeUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    var html = await res.text();
    return extractText(html, maxChars || MAX_CHARS_PAGE);
  } catch (err) {
    clearTimeout(timer);
    return '';
  }
}


// ── AI crawler visibility check ───────────────────────────────────────────────
// Real bot user-agents fetching the homepage the same way GPTBot/PerplexityBot/
// ClaudeBot actually do (plain HTTP, no JS execution \u2014 which is exactly what
// these crawlers do too). Compares visible text length against a normal fetch
// to catch the "empty shell" problem: sites that pass every static check
// (schema, llms.txt, meta tags) but serve a near-blank page to non-JS crawlers
// because their content is rendered client-side (common on Shopify/SPA builds).
// Google-Extended has no real distinct fetch identity \u2014 it's a robots.txt
// directive, not a crawler UA \u2014 so it's checked there instead of faked here.
var BOT_USER_AGENTS = [
  { key: 'gptbot',        label: 'GPTBot (OpenAI)',       ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot' },
  { key: 'perplexitybot', label: 'PerplexityBot',          ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
  { key: 'claudebot',     label: 'ClaudeBot (Anthropic)',  ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' }
];

async function fetchAsBot(url, userAgent) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': userAgent, 'Accept': 'text/html,application/xhtml+xml' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, textLength: 0 };
    var html = await res.text();
    var text = extractText(html, MAX_CHARS_PAGE);
    return { ok: true, textLength: text.trim().length };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, textLength: 0 };
  }
}

async function checkBotCrawlability(baseUrl, browserContentLength, robotsText) {
  var settled = await Promise.allSettled(
    BOT_USER_AGENTS.map(function(bot) { return fetchAsBot(baseUrl, bot.ua); })
  );

  var results = BOT_USER_AGENTS.map(function(bot, i) {
    var r = settled[i].status === 'fulfilled' ? settled[i].value : { ok: false, textLength: 0 };
    return { key: bot.key, label: bot.label, ok: r.ok, textLength: r.textLength };
  });

  // Google-Extended: check robots.txt directive, not a fake fetch identity.
  var googleExtendedBlocked = false;
  try {
    var rt = String(robotsText || '');
    var ge = rt.match(/User-agent:\s*Google-Extended[\s\S]*?(?=User-agent:|$)/i);
    if (ge && /Disallow:\s*\/\s*$/im.test(ge[0])) googleExtendedBlocked = true;
  } catch (e) {}

  // "Empty shell" detection: any bot that loaded successfully but saw under
  // 15% of what a normal fetch sees (or under 100 chars absolute) is getting
  // a near-blank page \u2014 the exact Shopify/SPA problem, a real Ease defect
  // that llms.txt/schema presence alone cannot reveal.
  var threshold = Math.max(100, browserContentLength * 0.15);
  var emptyShellBots = results.filter(function(r) { return r.ok && r.textLength < threshold; }).map(function(r) { return r.label; });
  var allBotsFailed   = results.every(function(r) { return !r.ok; });

  return {
    results: results,
    browserContentLength: browserContentLength,
    googleExtendedBlocked: googleExtendedBlocked,
    emptyShellDetected: emptyShellBots.length > 0,
    emptyShellBots: emptyShellBots,
    allBotsFailed: allBotsFailed
  };
}

// ── Fetch raw HTML ────────────────────────────────────────────────────────────
async function fetchHtml(url) {
  if (!url) return '';
  var safeUrl = url.startsWith('http') ? url : 'https://' + url;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetch(safeUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    return '';
  }
}

// ── Check whether {domain}/llms.txt actually exists ──────────────────────────
async function checkLlmsTxtExists(baseUrl) {
  if (!baseUrl) return false;
  var url = baseUrl.replace(/\/$/, '') + '/llms.txt';
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, LLMS_TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    var text = await res.text();
    var looksLikeHtml = /<html[\s>]|<!doctype html/i.test(text.slice(0, 200));
    return text.trim().length > 0 && !looksLikeHtml;
  } catch (err) {
    clearTimeout(timer);
    return false;
  }
}

// ── Check whether sitemap.xml exists ─────────────────────────────────────────
async function checkSitemapExists(baseUrl) {
  if (!baseUrl) return false;
  var url = baseUrl.replace(/\/$/, '') + '/sitemap.xml';
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 5000);
  try {
    var res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)' },
      signal: controller.signal
    });
    if (res.ok) { clearTimeout(timer); return true; }
    // A number of valid sites reject HEAD while serving the file normally.
    // Confirm with GET before recording a false missing-sitemap signal.
    if (res.status === 403 || res.status === 405 || res.status === 501) {
      clearTimeout(timer);
      controller = new AbortController();
      timer = setTimeout(function() { controller.abort(); }, 5000);
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)' },
        signal: controller.signal
      });
    }
    clearTimeout(timer);
    return res.ok;
  } catch (err) {
    clearTimeout(timer);
    return false;
  }
}

// ── Check whether robots.txt exists ──────────────────────────────────────────
async function checkRobotsExists(baseUrl) {
  if (!baseUrl) return false;
  var url = baseUrl.replace(/\/$/, '') + '/robots.txt';
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 5000);
  try {
    var res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)' },
      signal: controller.signal
    });
    if (res.ok) { clearTimeout(timer); return true; }
    if (res.status === 403 || res.status === 405 || res.status === 501) {
      clearTimeout(timer);
      controller = new AbortController();
      timer = setTimeout(function() { controller.abort(); }, 5000);
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)' },
        signal: controller.signal
      });
    }
    clearTimeout(timer);
    return res.ok;
  } catch (err) {
    clearTimeout(timer);
    return false;
  }
}

// ── Strip HTML to readable text ───────────────────────────────────────────────
function extractText(html, maxChars) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars || MAX_CHARS_PAGE);
}

// ── Extract schema markup from HTML ──────────────────────────────────────────
function extractSchema(html) {
  if (!html) return { found: false, types: [], count: 0, raw: '' };
  var schemas = [];
  var types   = [];

  var regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = regex.exec(html)) !== null) {
    try {
      var parsed = JSON.parse(match[1].trim());
      schemas.push(parsed);

      if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
        parsed['@graph'].forEach(function(item) {
          if (item && item['@type']) {
            var t = Array.isArray(item['@type']) ? item['@type'].join(',') : item['@type'];
            if (t) types.push(t);
          }
        });
      } else if (parsed['@type']) {
        var t = Array.isArray(parsed['@type']) ? parsed['@type'].join(',') : parsed['@type'];
        if (t) types.push(t);
      }
    } catch (e) {
      // Invalid JSON-LD — skip
    }
  }

  return {
    found:  schemas.length > 0,
    types:  types,
    count:  schemas.length,
    raw:    schemas.length > 0 ? JSON.stringify(schemas[0]).slice(0, 500) : ''
  };
}

// ── Extract meta tags ─────────────────────────────────────────────────────────
function extractMeta(html) {
  if (!html) return {};

  // Headings must be extracted from page markup, never from JavaScript strings
  // that happen to contain "<h1>" or "<h2>". Allow nested spans and other
  // inline markup inside real headings, then reduce the result to visible text.
  var headingHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ');

  function decodeBasicEntities(value) {
    return String(value || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, function(_, code) { return String.fromCharCode(Number(code)); })
      .replace(/&#x([0-9a-f]+);/gi, function(_, code) { return String.fromCharCode(parseInt(code, 16)); });
  }

  function visibleHeadingText(innerHtml) {
    return decodeBasicEntities(String(innerHtml || '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ').trim();
  }

  function getMeta(name) {
    var patterns = [
      new RegExp('<meta[^>]+name=["\']' + name + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'),
      new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']' + name + '["\']', 'i')
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = html.match(patterns[i]);
      if (m) return m[1].trim();
    }
    return '';
  }

  function getOg(prop) {
    var patterns = [
      new RegExp('<meta[^>]+property=["\']og:' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'),
      new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:' + prop + '["\']', 'i')
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = html.match(patterns[i]);
      if (m) return m[1].trim();
    }
    return '';
  }

  var h1Match = headingHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  var h1 = h1Match ? visibleHeadingText(h1Match[1]) : '';

  var h2s = [];
  var h2Regex = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  var h2Match;
  while ((h2Match = h2Regex.exec(headingHtml)) !== null && h2s.length < 5) {
    var h2Text = visibleHeadingText(h2Match[1]);
    if (h2Text) h2s.push(h2Text);
  }

  var mentionsLlmsTxt = html.toLowerCase().includes('llms.txt');

  var canonicalMatch = html.match(/<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)["\']>/i);
  var canonical = canonicalMatch ? canonicalMatch[1].trim() : '';

  return {
    title:           getMeta('title') || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '',
    description:     getMeta('description'),
    keywords:        getMeta('keywords'),
    ogTitle:         getOg('title'),
    ogDescription:   getOg('description'),
    ogType:          getOg('type'),
    h1:              h1,
    h2s:             h2s,
    canonical:       canonical,
    mentionsLlmsTxt: mentionsLlmsTxt
  };
}

// ── Build website text summary for Claude ─────────────────────────────────────
function buildWebsiteSummary(meta, schema, homepageText, aboutText, llmsTxtExists) {
  var parts = [];

  if (meta.h1)          parts.push('H1: ' + meta.h1);
  if (meta.title)       parts.push('Title: ' + meta.title);
  if (meta.description) parts.push('Meta description: ' + meta.description);
  if (meta.h2s && meta.h2s.length > 0) parts.push('H2s: ' + meta.h2s.join(' | '));
  if (meta.ogTitle)     parts.push('OG Title: ' + meta.ogTitle);
  if (meta.canonical)   parts.push('Canonical: ' + meta.canonical);

  parts.push('llms.txt detected: ' + (llmsTxtExists ? 'YES (verified by direct fetch)' : 'NO'));

  parts.push('\nSCHEMA MARKUP:');
  if (schema.found) {
    parts.push('Schema found: YES (' + schema.count + ' block(s))');
    parts.push('Schema types: ' + schema.types.join(', '));
    parts.push('Schema sample: ' + schema.raw);
  } else {
    parts.push('Schema found: NO — no JSON-LD detected');
  }

  if (homepageText) parts.push('\nHOMEPAGE CONTENT:\n' + homepageText);
  if (aboutText)    parts.push('\nABOUT PAGE CONTENT:\n' + aboutText);

  return parts.join('\n');
}

// ── Main: fetch website evidence ──────────────────────────────────────────────
// Returns { text, signals } where:
//   text    — prose summary for Claude (unchanged from previous version)
//   signals — structured facts, certain ground truth, used directly by the
//             scoring engine without Claude re-interpreting them
async function fetchWebsiteText(url) {
  if (!url) return { text: '', signals: {} };
  var safeUrl = url.startsWith('http') ? url : 'https://' + url;
  var pageUrl = safeUrl.replace(/\/$/, '');
  var base = pageUrl;
  try { base = new URL(pageUrl).origin; } catch (e) {}

  // Fetch everything in parallel
  var settled = await Promise.allSettled([
    fetchHtml(pageUrl),                       // [0] submitted page HTML
    safeFetch(base + '/about',    MAX_CHARS_PAGE),  // [1] about page
    safeFetch(base + '/about-us', MAX_CHARS_PAGE),  // [2] about-us page
    checkLlmsTxtExists(base),                 // [3] llms.txt
    checkSitemapExists(base),                 // [4] sitemap.xml
    checkRobotsExists(base),                  // [5] robots.txt
    fetchHtml(base + '/robots.txt'),          // [6] raw robots.txt text, for Google-Extended check
  ]);

  var homepageHtml  = settled[0].status === 'fulfilled' ? settled[0].value : '';
  var aboutText1    = settled[1].status === 'fulfilled' ? settled[1].value : '';
  var aboutText2    = settled[2].status === 'fulfilled' ? settled[2].value : '';
  var aboutText     = aboutText1 || aboutText2;
  var llmsTxtExists = settled[3].status === 'fulfilled' ? settled[3].value : false;
  var sitemapExists = settled[4].status === 'fulfilled' ? settled[4].value : false;
  var robotsExists  = settled[5].status === 'fulfilled' ? settled[5].value : false;
  var robotsRawText = settled[6].status === 'fulfilled' ? settled[6].value : '';

  var meta          = extractMeta(homepageHtml);
  var schema        = extractSchema(homepageHtml);
  var homepageText  = extractText(homepageHtml, MAX_CHARS_PAGE);

  // AI crawler visibility \u2014 real bot user-agents, compared against the
  // normal fetch above. Runs after the main batch since it needs
  // homepageText's length as the comparison baseline.
  var botCrawl = null;
  try {
    botCrawl = await checkBotCrawlability(pageUrl, homepageText.trim().length, robotsRawText);
  } catch (e) {
    botCrawl = null;
  }

  // Specific schema types that are meaningful for AI selection
  var SPECIFIC_SCHEMA_TYPES = [
    'LocalBusiness', 'Service', 'Product', 'Organization',
    'SoftwareApplication', 'ProfessionalService', 'Store',
    'Restaurant', 'Hotel', 'MedicalOrganization', 'LegalService',
    'FinancialService', 'FoodEstablishment', 'EducationalOrganization'
  ];
  var hasSpecificSchema = schema.found && schema.types.some(function(t) {
    return SPECIFIC_SCHEMA_TYPES.some(function(s) { return t.includes(s); });
  });

  // ── Structured signals — certain ground truth ─────────────────────────────
  // These are facts extracted mechanically from the HTML and HTTP responses.
  // They are NOT interpretations. They are used directly by the scoring engine.
  var signals = {
    // Clarity signals
    hasTitle:           !!(meta.title && meta.title.length > 3),
    titleText:          meta.title || '',
    hasH1:              !!(meta.h1 && meta.h1.length > 3),
    h1Text:             meta.h1 || '',
    hasMetaDescription: !!(meta.description && meta.description.length > 10),
    metaDescriptionText: meta.description || '',
    hasOgTags:          !!(meta.ogTitle || meta.ogDescription),
    hasCanonical:       !!(meta.canonical),
    // Schema signals
    hasSchema:          schema.found,
    hasSpecificSchema:  hasSpecificSchema,
    schemaTypes:        schema.types,
    schemaCount:        schema.count,
    // Ease signals
    hasLlmsTxt:         llmsTxtExists,
    hasSitemap:         sitemapExists,
    hasRobots:          robotsExists,
    // Raw for Claude's use
    h2s:                meta.h2s || [],
    ogTitle:            meta.ogTitle || '',
    // AI crawler visibility \u2014 real bot fetches, not just static file checks
    botCrawlable:          botCrawl ? !botCrawl.allBotsFailed : null,
    allBotsFailed:         botCrawl ? botCrawl.allBotsFailed : null,
    botEmptyShellDetected: botCrawl ? botCrawl.emptyShellDetected : null,
    botEmptyShellBots:     botCrawl ? botCrawl.emptyShellBots : [],
    botCrawlResults:       botCrawl ? botCrawl.results : [],
    googleExtendedBlocked: botCrawl ? botCrawl.googleExtendedBlocked : null,
  };

  var text = buildWebsiteSummary(meta, schema, homepageText, aboutText, llmsTxtExists);

  return { text, signals };
}

// ── Fetch competitor homepage for comparison ──────────────────────────────────
async function fetchCompetitorText(domain) {
  if (!domain) return '';
  var url = 'https://' + domain.replace(/^https?:\/\//, '').replace(/^www\./, '');

  var settled = await Promise.allSettled([ fetchHtml(url) ]);
  var html = settled[0].status === 'fulfilled' ? settled[0].value : '';
  if (!html) return '';

  var meta   = extractMeta(html);
  var schema = extractSchema(html);
  var text   = extractText(html, MAX_CHARS_COMP);

  var parts = [];
  if (meta.h1)        parts.push('Competitor H1: ' + meta.h1);
  if (meta.description) parts.push('Competitor description: ' + meta.description);
  if (schema.found)   parts.push('Competitor schema: ' + schema.types.join(', '));
  if (text)           parts.push('Competitor content: ' + text);

  return parts.join('\n');
}

// ── Fetch review platform pages ───────────────────────────────────────────────
async function fetchReviewPages(serperResults) {
  if (!serperResults || !Array.isArray(serperResults)) return {};

  var REVIEW_PLATFORMS = {
    trustpilot: /trustpilot\.com\/review\//i,
    g2:         /g2\.com\/products\//i,
    glassdoor:  /glassdoor\.com\/(Overview|Reviews)\//i,
    capterra:   /capterra\.com\/p\//i,
    clutch:     /clutch\.co\/profile\//i
  };

  var found = {};
  for (var i = 0; i < serperResults.length; i++) {
    var link = serperResults[i].link || '';
    var keys = Object.keys(REVIEW_PLATFORMS);
    for (var k = 0; k < keys.length; k++) {
      if (!found[keys[k]] && REVIEW_PLATFORMS[keys[k]].test(link)) {
        found[keys[k]] = link;
      }
    }
  }

  if (Object.keys(found).length === 0) return {};

  var platforms = Object.keys(found);
  var tasks     = platforms.map(function(p) { return safeFetch(found[p], 2000); });
  var settled   = await Promise.allSettled(tasks);

  var results = {};
  for (var s = 0; s < settled.length; s++) {
    if (settled[s].status === 'fulfilled' && settled[s].value) {
      results[platforms[s]] = {
        url:      found[platforms[s]],
        text:     settled[s].value,
        platform: platforms[s]
      };
    }
  }
  return results;
}

// ── Build review summary text for Claude ──────────────────────────────────────
function buildReviewText(reviewPages) {
  if (!reviewPages || Object.keys(reviewPages).length === 0) {
    return 'No review platform pages found or accessible.';
  }
  var lines = [];
  var keys  = Object.keys(reviewPages);
  for (var i = 0; i < keys.length; i++) {
    var p = reviewPages[keys[i]];
    if (!p || !p.text) continue;
    lines.push('\n' + keys[i].toUpperCase() + ' (' + p.url + '):');
    lines.push(p.text.slice(0, 800));
  }
  return lines.join('\n') || 'Review pages found but not accessible.';
}

module.exports = {
  fetchWebsiteText:    fetchWebsiteText,
  fetchCompetitorText: fetchCompetitorText,
  fetchReviewPages:    fetchReviewPages,
  buildReviewText:     buildReviewText,
  extractSchema:       extractSchema,
  extractMeta:         extractMeta
};
