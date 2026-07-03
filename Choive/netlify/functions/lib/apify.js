// lib/apify.js
// CHOIVE Apify integration — fetches real review and social evidence
// Actors used:
//   - Trustpilot scraper: novi~trustpilot-scraper (via Trustpilot search)
//   - Google Maps reviews: compass~google-maps-reviews-scraper (fallback: nwua9Gu5YkAVuf7GY)
// Identity guard: results that do not verifiably match the diagnosed business
// are discarded — wrong-business reviews must never enter the evidence.
// ENV: APIFY_API_KEY

const APIFY_BASE  = 'https://api.apify.com/v2';
const TIMEOUT_MS  = 45000; // Apify runs can take 20-40s
const POLL_MS     = 3000;  // Poll every 3s for result

// ── Run an Apify actor and wait for result ────────────────────────────────────
async function runActor(actorId, input) {
  var apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) {
    console.warn('APIFY_API_KEY not set — skipping Apify');
    return null;
  }

  var startUrl = APIFY_BASE + '/acts/' + actorId + '/runs?token=' + apiKey;

  // Start the actor run
  var startRes = await fetch(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: input })
  }).catch(function(err) {
    console.warn('Apify start failed:', err.message);
    return null;
  });

  if (!startRes || !startRes.ok) {
    console.warn('Apify start returned', startRes ? startRes.status : 'no response');
    return null;
  }

  var startData = await startRes.json();
  var runId     = startData && startData.data && startData.data.id;
  if (!runId) {
    console.warn('Apify run ID not found');
    return null;
  }

  // Poll for completion
  var deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(function(r) { setTimeout(r, POLL_MS); });

    var statusRes = await fetch(
      APIFY_BASE + '/actor-runs/' + runId + '?token=' + apiKey
    ).catch(function() { return null; });

    if (!statusRes || !statusRes.ok) continue;

    var statusData = await statusRes.json();
    var status     = statusData && statusData.data && statusData.data.status;

    if (status === 'SUCCEEDED') {
      // Fetch dataset items
      var datasetId  = statusData.data.defaultDatasetId;
      var itemsRes   = await fetch(
        APIFY_BASE + '/datasets/' + datasetId + '/items?token=' + apiKey + '&limit=20'
      ).catch(function() { return null; });

      if (!itemsRes || !itemsRes.ok) return null;
      return await itemsRes.json();
    }

    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      console.warn('Apify run', status, 'for actor', actorId);
      return null;
    }
    // RUNNING or READY — keep polling
  }

  console.warn('Apify timeout for actor', actorId);
  return null;
}

// ── Identity guard ────────────────────────────────────────────────────
// Confirms a scraped result actually belongs to the diagnosed business before
// its reviews and ratings are allowed into the evidence. Two accepted proofs:
// 1. The result URL contains the business domain (Trustpilot company URLs
//    embed the domain, e.g. trustpilot.com/review/example.com) — strongest.
// 2. Every significant word of the business name appears in the result name
//    — same matching standard the AI simulation uses. A single shared word
//    (e.g. "Panorama") must never attribute another company's reviews.
function looksLikeSameBusiness(candidateName, candidateUrl, businessName, domain) {
  var cn = String(candidateName || '').toLowerCase().trim();
  var bn = String(businessName  || '').toLowerCase().trim();
  var d  = String(domain        || '').toLowerCase().trim();

  if (d && String(candidateUrl || '').toLowerCase().indexOf(d) !== -1) return true;
  if (!cn || !bn) return false;
  if (cn.indexOf(bn) !== -1 || bn.indexOf(cn) !== -1) return true;

  var words = bn.split(/\s+/).filter(function(w) { return w.length > 2; });
  if (words.length === 0) return false;
  return words.every(function(w) { return cn.indexOf(w) !== -1; });
}

// ── Fetch Trustpilot reviews ──────────────────────────────────────────────────
async function fetchTrustpilot(businessName, website) {
  // Build Trustpilot search URL from business name
  var domain  = (website || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  var tpQuery = domain || businessName;

  var items = await runActor('novi~trustpilot-scraper', {
    startUrls: [{ url: 'https://www.trustpilot.com/search?query=' + encodeURIComponent(tpQuery) }],
    maxReviews: 10,
    reviewsLanguage: 'en'
  });

  if (!items || !Array.isArray(items) || items.length === 0) return null;

  var company = items[0];
  if (!company) return null;

  if (!looksLikeSameBusiness(company.name, company.url, businessName, domain)) {
    console.warn('[apify] Trustpilot result "' + (company.name || 'unknown') + '" does not match "' + businessName + '" — discarded to keep evidence authentic');
    return null;
  }

  var reviews = (company.reviews || []).slice(0, 5).map(function(r) {
    return (r.rating ? r.rating + '/5: ' : '') + (r.text || '').slice(0, 200);
  });

  return {
    platform:     'trustpilot',
    name:         company.name         || businessName,
    rating:       company.rating       || null,
    reviewCount:  company.reviewCount  || 0,
    ratingLabel:  company.ratingLabel  || '',
    url:          company.url          || '',
    reviews:      reviews,
    source:       'apify'
  };
}

// ── Fetch Google Maps reviews ─────────────────────────────────────────────────
async function fetchGoogleReviews(businessName, city) {
  var query = businessName + (city ? ' ' + city : '');

  // Try multiple actor IDs - Google Maps actors change frequently
  var actors = [
    { id: 'compass~google-maps-reviews-scraper', input: { searchStringsArray: [query], maxReviews: 10, language: 'en', maxCrawledPlaces: 1 } },
    { id: 'nwua9Gu5YkAVuf7GY', input: { searchString: query, maxReviews: 10 } }
  ];

  var items = null;
  for (var i = 0; i < actors.length; i++) {
    items = await runActor(actors[i].id, actors[i].input);
    if (items && Array.isArray(items) && items.length > 0) break;
    items = null;
  }

  if (!items || !Array.isArray(items) || items.length === 0) return null;

  var place = items[0];
  if (!place) return null;

  if (!looksLikeSameBusiness(place.title, place.website, businessName, '')) {
    console.warn('[apify] Google result "' + (place.title || 'unknown') + '" does not match "' + businessName + '" — discarded to keep evidence authentic');
    return null;
  }

  var reviews = (place.reviews || []).slice(0, 5).map(function(r) {
    return (r.stars ? r.stars + '/5: ' : '') + (r.text || '').slice(0, 200);
  });

  return {
    platform:    'google_reviews',
    name:        place.title          || businessName,
    rating:      place.totalScore     || null,
    reviewCount: place.reviewsCount   || 0,
    address:     place.address        || '',
    category:    place.categoryName   || '',
    website:     place.website        || '',
    reviews:     reviews,
    source:      'apify'
  };
}

// ── Build review text for Claude prompt ───────────────────────────────────────
function buildApifyText(trustpilot, googleReviews) {
  var parts = [];

  if (trustpilot) {
    parts.push('\nTRUSTPILOT:');
    parts.push('Rating: ' + (trustpilot.rating || 'not found') + ' — ' + trustpilot.reviewCount + ' reviews');
    if (trustpilot.ratingLabel) parts.push('Label: ' + trustpilot.ratingLabel);
    if (trustpilot.reviews && trustpilot.reviews.length > 0) {
      parts.push('Recent reviews:');
      trustpilot.reviews.forEach(function(r) { parts.push('  - ' + r); });
    }
  }

  if (googleReviews) {
    parts.push('\nGOOGLE REVIEWS:');
    parts.push('Rating: ' + (googleReviews.rating || 'not found') + ' — ' + googleReviews.reviewCount + ' reviews');
    if (googleReviews.category) parts.push('Category: ' + googleReviews.category);
    if (googleReviews.reviews && googleReviews.reviews.length > 0) {
      parts.push('Recent reviews:');
      googleReviews.reviews.forEach(function(r) { parts.push('  - ' + r); });
    }
  }

  return parts.length > 0 ? parts.join('\n') : 'No review platform data retrieved.';
}

// ── Main: fetch all Apify evidence in parallel ────────────────────────────────
async function fetchApifyEvidence(name, city, website) {
  // Skip if no API key configured
  if (!process.env.APIFY_API_KEY) {
    console.warn('[apify] APIFY_API_KEY not set — skipping review collection');
    return { trustpilot: null, googleReviews: null, apifyText: '' };
  }

  // Run Trustpilot and Google Reviews in parallel
  // Timeout each independently — one failure should not block the other
  var settled = await Promise.allSettled([
    fetchTrustpilot(name, website),
    fetchGoogleReviews(name, city)
  ]);

  var trustpilot    = settled[0].status === 'fulfilled' ? settled[0].value : null;
  var googleReviews = settled[1].status === 'fulfilled' ? settled[1].value : null;

  var apifyText = buildApifyText(trustpilot, googleReviews);

  console.log('[apify] trustpilot:', trustpilot ? trustpilot.reviewCount + ' reviews' : 'not found');
  console.log('[apify] googleReviews:', googleReviews ? googleReviews.reviewCount + ' reviews' : 'not found');

  return { trustpilot, googleReviews, apifyText };
}

module.exports = { fetchApifyEvidence: fetchApifyEvidence, buildApifyText: buildApifyText };
