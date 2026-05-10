// lib/fetchWebsite.js
// CHOIVE website evidence extractor
// Fetches homepage + about page, extracts schema, meta, H1/H2, OG tags
// Also fetches competitor homepage for comparison

const TIMEOUT_MS     = 8000;
const MAX_CHARS_PAGE = 3000;
const MAX_CHARS_COMP = 2000;

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
  if (!html) return { found: false, types: [], raw: '' };
  var schemas = [];
  var types   = [];

  // Find all JSON-LD blocks
  var regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = regex.exec(html)) !== null) {
    try {
      var parsed = JSON.parse(match[1].trim());
      schemas.push(parsed);
      var type = parsed['@type'] || (Array.isArray(parsed['@type']) ? parsed['@type'].join(',') : '');
      if (type) types.push(type);
    } catch (e) {
      // Invalid JSON-LD — skip
    }
  }

  return {
    found:   schemas.length > 0,
    types:   types,
    count:   schemas.length,
    raw:     schemas.length > 0 ? JSON.stringify(schemas[0]).slice(0, 500) : ''
  };
}

// ── Extract meta tags ─────────────────────────────────────────────────────────
function extractMeta(html) {
  if (!html) return {};

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

  // Extract H1
  var h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  var h1 = h1Match ? h1Match[1].trim() : '';

  // Extract H2s
  var h2s = [];
  var h2Regex = /<h2[^>]*>([^<]+)<\/h2>/gi;
  var h2Match;
  while ((h2Match = h2Regex.exec(html)) !== null && h2s.length < 5) {
    h2s.push(h2Match[1].trim());
  }

  // Check llms.txt
  var hasLlmsTxt = html.toLowerCase().includes('llms.txt');

  // Check canonical
  var canonicalMatch = html.match(/<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)["\']>/i);
  var canonical = canonicalMatch ? canonicalMatch[1].trim() : '';

  return {
    title:       getMeta('title') || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '',
    description: getMeta('description'),
    keywords:    getMeta('keywords'),
    ogTitle:     getOg('title'),
    ogDescription: getOg('description'),
    ogType:      getOg('type'),
    h1:          h1,
    h2s:         h2s,
    canonical:   canonical,
    hasLlmsTxt:  hasLlmsTxt
  };
}

// ── Build structured website summary for Claude ───────────────────────────────
function buildWebsiteSummary(meta, schema, homepageText, aboutText) {
  var parts = [];

  if (meta.h1)          parts.push('H1: ' + meta.h1);
  if (meta.title)       parts.push('Title: ' + meta.title);
  if (meta.description) parts.push('Meta description: ' + meta.description);
  if (meta.h2s && meta.h2s.length > 0) parts.push('H2s: ' + meta.h2s.join(' | '));
  if (meta.ogTitle)     parts.push('OG Title: ' + meta.ogTitle);
  if (meta.canonical)   parts.push('Canonical: ' + meta.canonical);
  parts.push('llms.txt detected: ' + (meta.hasLlmsTxt ? 'YES' : 'NO'));

  parts.push('\nSCHEMA MARKUP:');
  if (schema.found) {
    parts.push('Schema found: YES (' + schema.count + ' block(s))');
    parts.push('Schema types: ' + schema.types.join(', '));
    parts.push('Schema sample: ' + schema.raw);
  } else {
    parts.push('Schema found: NO — no JSON-LD detected');
  }

  if (homepageText) {
    parts.push('\nHOMEPAGE CONTENT:\n' + homepageText);
  }

  if (aboutText) {
    parts.push('\nABOUT PAGE CONTENT:\n' + aboutText);
  }

  return parts.join('\n');
}

// ── Main: fetch website evidence ──────────────────────────────────────────────
async function fetchWebsiteText(url) {
  if (!url) return '';
  var safeUrl = url.startsWith('http') ? url : 'https://' + url;
  var base    = safeUrl.replace(/\/$/, '');

  // Fetch homepage HTML and about page in parallel
  var settled = await Promise.allSettled([
    fetchHtml(base),
    safeFetch(base + '/about', MAX_CHARS_PAGE),
    safeFetch(base + '/about-us', MAX_CHARS_PAGE)
  ]);

  var homepageHtml = settled[0].status === 'fulfilled' ? settled[0].value : '';
  var aboutText1   = settled[1].status === 'fulfilled' ? settled[1].value : '';
  var aboutText2   = settled[2].status === 'fulfilled' ? settled[2].value : '';
  var aboutText    = aboutText1 || aboutText2;

  var meta         = extractMeta(homepageHtml);
  var schema       = extractSchema(homepageHtml);
  var homepageText = extractText(homepageHtml, MAX_CHARS_PAGE);

  return buildWebsiteSummary(meta, schema, homepageText, aboutText);
}

// ── Fetch competitor homepage for comparison ──────────────────────────────────
async function fetchCompetitorText(domain) {
  if (!domain) return '';
  var url = 'https://' + domain.replace(/^https?:\/\//, '').replace(/^www\./, '');

  var settled = await Promise.allSettled([
    fetchHtml(url)
  ]);

  var html = settled[0].status === 'fulfilled' ? settled[0].value : '';
  if (!html) return '';

  var meta   = extractMeta(html);
  var schema = extractSchema(html);
  var text   = extractText(html, MAX_CHARS_COMP);

  var parts = [];
  if (meta.h1)          parts.push('Competitor H1: ' + meta.h1);
  if (meta.description) parts.push('Competitor description: ' + meta.description);
  if (schema.found)     parts.push('Competitor schema: ' + schema.types.join(', '));
  if (text)             parts.push('Competitor content: ' + text);

  return parts.join('\n');
}

module.exports = {
  fetchWebsiteText:     fetchWebsiteText,
  fetchCompetitorText:  fetchCompetitorText,
  extractSchema:        extractSchema,
  extractMeta:          extractMeta
};
