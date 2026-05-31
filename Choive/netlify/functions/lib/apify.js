// lib/apify.js
// CHOIVE Apify integration — fetches real review and social evidence
// Actors used:
//   - Trustpilot scraper: easyapify/trustpilot-scraper
//   - Google Maps reviews: compass/google-maps-reviews-scraper
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

// ── Fetch Trustpilot reviews ──────────────────────────────────────────────────
async function fetchTrustpilot(businessName, website) {
  // Build Trustpilot search URL from business name
  var domain  = (website || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  var tpQuery = domain || businessName;

  var items = await runActor('easyapify~trustpilot-scraper', {
    startUrls: [{ url: 'https://www.trustpilot.com/search?query=' + encodeURIComponent(tpQuery) }],
    maxReviews: 10,
    reviewsLanguage: 'en'
  });

  if (!items || !Array.isArray(items) || items.length === 0) return null;

  var company = items[0];
  if (!company) return null;

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
  // Apify disabled — actor IDs need verification on apify.com/store
  // To re-enable: find correct actor IDs, update fetchTrustpilot and fetchGoogleReviews above
  return { trustpilot: null, googleReviews: null, apifyText: '' };
}

module.exports = { fetchApifyEvidence: fetchApifyEvidence, buildApifyText: buildApifyText };
