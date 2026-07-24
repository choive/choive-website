// lib/apify.js
// CHOIVE Apify integration — fetches real review and social evidence
// Actors used:
//   - Trustpilot scraper: TWO confirmed-real IDs, tried in sequence —
//     automation-lab~trustpilot, then zen-studio~trustpilot-review-scraper.
//     Both IDs came from each actor's own API endpoint docs (trustworthy;
//     Store display names cannot be trusted — see the Google Maps note
//     above). INPUT SCHEMA UNVERIFIED for either: the fields below
//     (startUrls/maxReviews/reviewsLanguage) are carried over from an older,
//     different actor and may not match what these expect. If runs start
//     (no 404) but return no/wrong data, check each actor's own "Input" tab
//     in Apify Console for its real field names.
//   - Google Maps reviews: powerai~google-map-reviews-scraper — CONFIRMED
//     2026-07-07 directly from this actor's own generated API endpoint docs.
//     Two prior IDs were tried and both 404’d because the Apify Store page
//     displays "Crafted by Compass" as a maintainer/brand label — the actual
//     API owner username is "powerai", an entirely different string that no
//     amount of reading the Store page's URL or copy-icon could have revealed.
// Identity guard: results that do not verifiably match the diagnosed business
// are discarded — wrong-business reviews must never enter the evidence.
// ENV: APIFY_API_KEY

const APIFY_BASE  = 'https://api.apify.com/v2';
const TIMEOUT_MS  = 15000; // Apify runs can take 20-40s
const POLL_MS     = 3000;  // Poll every 3s for result

// ── Run an Apify actor and wait for result ────────────────────────────────────
async function runActor(actorId, input) {
  var apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) {
    console.warn('APIFY_API_KEY not set — skipping Apify');
    return { state: 'unavailable', items: null };
  }

  var startUrl = APIFY_BASE + '/acts/' + actorId + '/runs?token=' + apiKey;

  // Start the actor run
  var startRes = await fetch(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  }).catch(function(err) {
    console.warn('Apify start failed:', err.message);
    return { state: 'unavailable', items: null };
  });

  if (!startRes || !startRes.ok) {
    var startStatus = startRes ? startRes.status : 'no response';
    console.warn('Apify start returned', startStatus, 'for actor', actorId);
    if (startRes && startStatus === 400) {
      // 400 = the actor address is correct but the INPUT fields are wrong \u2014
      // a different, more specific problem than 404's wrong-address. Surface
      // Apify's own error text so the actual bad field is visible in logs.
      try {
        var errBody = await startRes.text();
        console.warn('Apify 400 detail for', actorId + ':', errBody.slice(0, 300));
      } catch (e) {}
    }
    return { state: 'unavailable', items: null };
  }

  var startData = await startRes.json();
  var runId     = startData && startData.data && startData.data.id;
  if (!runId) {
    console.warn('Apify run ID not found');
    return { state: 'unavailable', items: null };
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

      if (!itemsRes || !itemsRes.ok) return { state: 'unavailable', items: null };
      var items = await itemsRes.json();
      return { state: Array.isArray(items) && items.length ? 'available' : 'no_verified_match', items: items };
    }

    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      console.warn('Apify run', status, 'for actor', actorId);
      return { state: 'unavailable', items: null };
    }
    // RUNNING or READY — keep polling
  }

  console.warn('Apify timeout for actor', actorId);
  return { state: 'unavailable', items: null };
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
  // Both actors' own live error messages confirmed neither accepts a search
  // query \u2014 both want a direct Trustpilot company-page URL, just under
  // different field names: automation-lab wants "companyUrls" (an array;
  // pluralized, so following Apify convention of one-URL-per-array-slot),
  // zen-studio wants a single "businessUrl" string. Standard Trustpilot
  // company-page pattern: trustpilot.com/review/{domain}. Only attempted
  // when a domain is actually known \u2014 neither actor works from a name alone.
  var domain = (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain) return { data: null, status: 'not_measured' };
  var tpUrl = 'https://www.trustpilot.com/review/' + domain;

  // Search-style query, for the third candidate specifically \u2014 an OLDER
  // actor from an earlier disabled version of this file used a search URL,
  // not a direct company page. Different actors have proven to want
  // genuinely different schemas every single time today; this is real prior
  // information about THIS specific actor, not a guess.
  var tpQuery = businessName || domain;

  var tpAttempts = [
    { id: 'automation-lab~trustpilot',              input: { companyUrls: [{ url: tpUrl }], maxReviews: 10 } },
    { id: 'zen-studio~trustpilot-review-scraper',   input: { businessUrl: tpUrl,             maxReviews: 10 } },
    { id: 'easyapify~trustpilot-scraper',           input: { startUrls: [{ url: 'https://www.trustpilot.com/search?query=' + encodeURIComponent(tpQuery) }], maxReviews: 10, reviewsLanguage: 'en' } }
  ];
  var items = null;
  var measured = false;
  for (var t = 0; t < tpAttempts.length; t++) {
    var attempt = await runActor(tpAttempts[t].id, tpAttempts[t].input);
    if (attempt && attempt.state !== 'unavailable') measured = true;
    items = attempt && attempt.items;
    if (Array.isArray(items) && items.length > 0) break;
    items = null;
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return { data: null, status: measured ? 'no_verified_match' : 'unavailable' };
  }

  var company = items[0];
  if (!company) return { data: null, status: 'no_verified_match' };

  if (!looksLikeSameBusiness(company.name, company.url, businessName, domain)) {
    console.warn('[apify] Trustpilot result "' + (company.name || 'unknown') + '" does not match "' + businessName + '" — discarded to keep evidence authentic');
    return { data: null, status: 'no_verified_match' };
  }

  var reviews = (company.reviews || []).slice(0, 5).map(function(r) {
    return (r.rating ? r.rating + '/5: ' : '') + (r.text || '').slice(0, 200);
  });

  return { data: {
    platform:     'trustpilot',
    name:         company.name         || businessName,
    rating:       company.rating       || null,
    reviewCount:  company.reviewCount  || 0,
    ratingLabel:  company.ratingLabel  || '',
    url:          company.url          || '',
    reviews:      reviews,
    source:       'apify'
  }, status: 'available' };
}

// ── Fetch Google Maps reviews ─────────────────────────────────────────────────
async function fetchGoogleReviews(businessName, city) {
  var query = businessName + (city ? ' ' + city : '');

  // Confirmed working actor \u2014 the raw-ID fallback that used to sit here
  // 404'd on every single test today; removed as dead weight, not a safety net.
  var actors = [
    { id: 'powerai~google-map-reviews-scraper', input: { searchStringsArray: [query], maxReviews: 10, language: 'en', maxCrawledPlaces: 1 } }
  ];

  var items = null;
  var measured = false;
  for (var i = 0; i < actors.length; i++) {
    var attempt = await runActor(actors[i].id, actors[i].input);
    if (attempt && attempt.state !== 'unavailable') measured = true;
    items = attempt && attempt.items;
    if (Array.isArray(items) && items.length > 0) break;
    items = null;
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return { data: null, status: measured ? 'no_verified_match' : 'unavailable' };
  }

  var place = items[0];
  if (!place) return { data: null, status: 'no_verified_match' };

  if (!looksLikeSameBusiness(place.title, place.website, businessName, '')) {
    console.warn('[apify] Google result "' + (place.title || 'unknown') + '" does not match "' + businessName + '" — discarded to keep evidence authentic');
    return { data: null, status: 'no_verified_match' };
  }

  var reviews = (place.reviews || []).slice(0, 5).map(function(r) {
    return (r.stars ? r.stars + '/5: ' : '') + (r.text || '').slice(0, 200);
  });

  return { data: {
    platform:    'google_reviews',
    name:        place.title          || businessName,
    rating:      place.totalScore     || null,
    reviewCount: place.reviewsCount   || 0,
    address:     place.address        || '',
    category:    place.categoryName   || '',
    website:     place.website        || '',
    reviews:     reviews,
    source:      'apify'
  }, status: 'available' };
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

  // No returned data is not proof that reviews do not exist. The actor may be
  // unavailable, forbidden for this Apify account, timed out, or may simply
  // have found no identity-safe match. Keep the scoring prompt neutral instead
  // of turning an unmeasured source into negative trust evidence.
  return parts.length > 0 ? parts.join('\n') : '';
}

// ── Main: fetch all Apify evidence in parallel ────────────────────────────────
async function fetchApifyEvidence(name, city, website) {
  // Skip if no API key configured
  if (!process.env.APIFY_API_KEY) {
    console.warn('[apify] APIFY_API_KEY not set — skipping review collection');
    return {
      trustpilot: null,
      googleReviews: null,
      apifyText: '',
      measurement: { trustpilot: 'not_measured', googleReviews: 'not_measured' }
    };
  }

  // Run Trustpilot and Google Reviews in parallel
  // Timeout each independently — one failure should not block the other
  var settled = await Promise.allSettled([
    fetchTrustpilot(name, website),
    fetchGoogleReviews(name, city)
  ]);

  var trustpilotResult = settled[0].status === 'fulfilled' ? settled[0].value : { data: null, status: 'unavailable' };
  var googleResult = settled[1].status === 'fulfilled' ? settled[1].value : { data: null, status: 'unavailable' };
  var trustpilot = trustpilotResult && trustpilotResult.data;
  var googleReviews = googleResult && googleResult.data;
  var measurement = {
    trustpilot: trustpilotResult && trustpilotResult.status || 'unavailable',
    googleReviews: googleResult && googleResult.status || 'unavailable'
  };

  var apifyText = buildApifyText(trustpilot, googleReviews);

  console.log('[apify] trustpilot:', trustpilot ? trustpilot.reviewCount + ' reviews' : measurement.trustpilot);
  console.log('[apify] googleReviews:', googleReviews ? googleReviews.reviewCount + ' reviews' : measurement.googleReviews);

  return { trustpilot, googleReviews, apifyText, measurement };
}

module.exports = { fetchApifyEvidence: fetchApifyEvidence, buildApifyText: buildApifyText };
