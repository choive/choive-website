// lib/social.js
// CHOIVE social evidence collector
// Fetches public social media pages found in Serper results
// YouTube Data API for channel stats
// ENV: YOUTUBE_API_KEY (optional — falls back to page fetch)

const TIMEOUT_MS = 7000;

// ── Safe fetch with timeout ───────────────────────────────────────────────────
async function safeFetch(url, options) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetch(url, Object.assign({ signal: controller.signal }, options || {}));
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

// ── Extract text from HTML ────────────────────────────────────────────────────
function extractText(html, max) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 1500);
}

// ── YouTube Data API ──────────────────────────────────────────────────────────
async function fetchYouTubeChannel(channelUrl) {
  if (!channelUrl) return null;
  var apiKey = process.env.YOUTUBE_API_KEY;

  // Extract channel identifier from URL
  var handleMatch  = channelUrl.match(/@([^/?&]+)/);
  var channelMatch = channelUrl.match(/\/channel\/([^/?&]+)/);
  var userMatch    = channelUrl.match(/\/user\/([^/?&]+)/);

  var identifier = null;
  var searchType = null;

  if (handleMatch) {
    identifier = '@' + handleMatch[1];
    searchType = 'handle';
  } else if (channelMatch) {
    identifier = channelMatch[1];
    searchType = 'id';
  } else if (userMatch) {
    identifier = userMatch[1];
    searchType = 'user';
  }

  if (!identifier) return null;

  // If no API key, fall back to page fetch
  if (!apiKey) {
    return fetchPageFallback(channelUrl, 'youtube');
  }

  try {
    var searchUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q='
      + encodeURIComponent(identifier) + '&key=' + apiKey + '&maxResults=1';
    var searchRes = await safeFetch(searchUrl);
    if (!searchRes || !searchRes.ok) return fetchPageFallback(channelUrl, 'youtube');

    var searchData = await searchRes.json();
    var channelId  = searchData.items && searchData.items[0] && searchData.items[0].id
      ? searchData.items[0].id.channelId
      : null;

    if (!channelId) return fetchPageFallback(channelUrl, 'youtube');

    var statsUrl = 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id='
      + channelId + '&key=' + apiKey;
    var statsRes = await safeFetch(statsUrl);
    if (!statsRes || !statsRes.ok) return fetchPageFallback(channelUrl, 'youtube');

    var statsData = await statsRes.json();
    var ch = statsData.items && statsData.items[0];
    if (!ch) return fetchPageFallback(channelUrl, 'youtube');

    var stats   = ch.statistics || {};
    var snippet = ch.snippet    || {};

    return {
      platform:      'youtube',
      url:           channelUrl,
      name:          snippet.title          || '',
      description:   snippet.description    || '',
      subscribers:   stats.subscriberCount  || '0',
      videoCount:    stats.videoCount       || '0',
      viewCount:     stats.viewCount        || '0',
      publishedAt:   snippet.publishedAt    || '',
      source:        'youtube_api'
    };
  } catch (err) {
    console.warn('YouTube API error:', err.message);
    return fetchPageFallback(channelUrl, 'youtube');
  }
}

// ── Generic page fetch fallback ───────────────────────────────────────────────
async function fetchPageFallback(url, platform) {
  if (!url) return null;
  var res = await safeFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHOIVE-Bot/1.0)' }
  });
  if (!res || !res.ok) return null;

  var html = await res.text();
  var text = extractText(html, 1200);
  if (!text) return null;

  return {
    platform:  platform || 'unknown',
    url:       url,
    text:      text,
    source:    'page_fetch'
  };
}

// ── Reddit page fetch ─────────────────────────────────────────────────────────
async function fetchRedditPage(url) {
  if (!url) return null;
  // Use Reddit JSON API
  var jsonUrl = url.replace(/\/$/, '') + '.json?limit=5';
  var res = await safeFetch(jsonUrl, {
    headers: { 'User-Agent': 'CHOIVE-Bot/1.0' }
  });
  if (!res || !res.ok) return fetchPageFallback(url, 'reddit');

  try {
    var data    = await res.json();
    var listing = Array.isArray(data) ? data[0] : data;
    var posts   = listing && listing.data && listing.data.children
      ? listing.data.children.slice(0, 3).map(function(p) {
          return (p.data.title || '') + ': ' + (p.data.selftext || '').slice(0, 200);
        }).join(' | ')
      : '';

    return {
      platform: 'reddit',
      url:      url,
      text:     posts || '',
      source:   'reddit_api'
    };
  } catch (err) {
    return fetchPageFallback(url, 'reddit');
  }
}

// ── Detect and fetch all social pages from Serper results ─────────────────────
async function fetchSocialEvidence(serperResults, businessName) {
  if (!serperResults || !Array.isArray(serperResults)) return {};

  var PLATFORM_PATTERNS = {
    youtube:   /youtube\.com\/(channel|user|c|@)/i,
    linkedin:  /linkedin\.com\/company\//i,
    instagram: /instagram\.com\/[^/]+\/?$/i,
    tiktok:    /tiktok\.com\/@/i,
    facebook:  /facebook\.com\/[^/]+\/?$/i,
    reddit:    /reddit\.com\/(r|u)\//i,
    twitter:   /twitter\.com\/|x\.com\//i
  };

  // Find matching URLs in Serper results
  var found = {};
  for (var i = 0; i < serperResults.length; i++) {
    var link = (serperResults[i].link || '').toLowerCase();
    var keys = Object.keys(PLATFORM_PATTERNS);
    for (var k = 0; k < keys.length; k++) {
      var detectedPlatform = keys[k];
      if (!found[detectedPlatform] && PLATFORM_PATTERNS[detectedPlatform].test(link)) {
        found[detectedPlatform] = serperResults[i].link;
      }
    }
  }

  if (Object.keys(found).length === 0) return {};

  // Fetch each detected platform in parallel
  var fetchTasks = [];
  var platforms  = Object.keys(found);

  for (var p = 0; p < platforms.length; p++) {
    var fetchPlatform = platforms[p];
    var url      = found[fetchPlatform];
    if (fetchPlatform === 'youtube') {
      fetchTasks.push(fetchYouTubeChannel(url));
    } else if (fetchPlatform === 'reddit') {
      fetchTasks.push(fetchRedditPage(url));
    } else {
      fetchTasks.push(fetchPageFallback(url, fetchPlatform));
    }
  }

  var settled = await Promise.allSettled(fetchTasks);
  var evidence = {};

  for (var s = 0; s < settled.length; s++) {
    if (settled[s].status === 'fulfilled' && settled[s].value) {
      var completedPlatform = platforms[s];
      evidence[completedPlatform] = settled[s].value;
    }
  }

  return evidence;
}

// ── Build social text for Claude prompt ───────────────────────────────────────
function buildSocialText(socialEvidence) {
  if (!socialEvidence || Object.keys(socialEvidence).length === 0) {
    return 'No social media pages found or accessible.';
  }

  var lines = [];
  var keys  = Object.keys(socialEvidence);

  for (var i = 0; i < keys.length; i++) {
    var platform = keys[i];
    var data     = socialEvidence[platform];
    if (!data) continue;

    lines.push('\n' + platform.toUpperCase() + ' (' + (data.url || '') + '):');

    if (platform === 'youtube' && data.subscribers) {
      lines.push('  Subscribers: ' + data.subscribers);
      lines.push('  Videos: '      + data.videoCount);
      lines.push('  Total views: ' + data.viewCount);
      if (data.description) lines.push('  Description: ' + data.description.slice(0, 300));
    } else if (data.text) {
      lines.push('  ' + data.text.slice(0, 400));
    }
  }

  return lines.join('\n') || 'Social pages found but content not accessible.';
}

module.exports = {
  fetchSocialEvidence: fetchSocialEvidence,
  fetchYouTubeChannel: fetchYouTubeChannel,
  buildSocialText:     buildSocialText
};
