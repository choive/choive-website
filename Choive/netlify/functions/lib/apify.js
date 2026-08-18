// lib/apify.js
// CHOIVE Apify integration — fetches real review and social evidence
// Actors used:
//   - Trustpilot scraper: TWO confirmed-real IDs, tried in sequence —
//     automation-lab~trustpilot, then zen-studio~trustpilot-review-scraper.
//     INPUT SCHEMAS VERIFIED against each actor's live build input schema AND
//     a real test run (2026-08): automation-lab requires companyUrls (array of
//     domain/URL STRINGS) + maxReviewsPerCompany; zen-studio requires
//     businessUrl (string) + maxResults. A previously listed third actor
//     (easyapify~trustpilot-scraper) was removed — it 404'd because it does not
//     exist in this account. Both actors return a FLAT list of review objects,
//     normalised by normalizeTrustpilot() below.
//   - Google Maps reviews: compass~Google-Maps-Reviews-Scraper — VERIFIED live
//     (2026-08). Takes a Maps place OR search URL in "startUrls" and returns a
//     FLAT list of review objects that ALSO carry place identity (title,
//     totalScore, reviewsCount, address, categoryName). Replaced the previous
//     powerai~google-map-reviews-scraper, which returned raw reviews with NO
//     place name/rating/count (nothing verifiable) and resolved to unrelated
//     businesses in testing.
// Identity guard: results that do not verifiably match the diagnosed business
// are discarded — wrong-business reviews must never enter the evidence.
// ENV: APIFY_API_KEY

const APIFY_BASE  = 'https://api.apify.com/v2';
// Trustpilot actors routinely take 30-60s (they drive a headless browser
// through Trustpilot's anti-bot walls). The old 15s cap aborted almost every
// run before it finished, which is why logs showed "Apify timeout". 90s gives
// a real run room to complete while still bounding the diagnostic's total time.
const TIMEOUT_MS  = 90000;
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

// ── Normalise Trustpilot actor output ─────────────────────────────────────────
// Normalise a Trustpilot actor's output into one shape. Both supported actors
// return a FLAT list of review objects (one item per review), NOT a single
// company object with nested reviews. Company-level facts (name, rating, total
// review count) are embedded on each review item under actor-specific keys:
//   automation-lab: companyName / companyUrl / companyTrustScore (or
//                   companyStars) / companyTotalReviews, per-review rating+text.
//   zen-studio:     businessName / businessUrl, per-review rating+text; it does
//                   NOT expose a company-level score or total, so those stay
//                   null/0 — reviews and identity are still usable.
// All field names below were confirmed against each actor's live output.
function normalizeTrustpilot(items) {
  var first = items[0] || {};
  var name = first.companyName || first.businessName || first.name || '';
  var url  = first.companyUrl  || first.businessUrl  || first.url  || '';
  // Company aggregate rating — never fall back to first.rating, which on these
  // actors is the FIRST REVIEW's star rating, not the company's TrustScore.
  var ratingRaw = first.companyTrustScore != null ? first.companyTrustScore
    : (first.companyStars != null ? first.companyStars
    : (first.trustScore != null ? first.trustScore : null));
  var rating = ratingRaw != null ? Number(ratingRaw) : null;
  var reviewCount = Number(first.companyTotalReviews || first.totalReviews || first.reviewCount || 0) || 0;

  var reviews = items.filter(function(r) {
    return r && (r.text || r.title);
  }).slice(0, 5).map(function(r) {
    var stars = r.rating || r.stars || r.score;
    var head = r.title ? String(r.title).trim() + ' — ' : '';
    return (stars ? stars + '/5: ' : '') + head + String(r.text || '').slice(0, 200);
  });

  return { name: name, url: url, rating: rating, reviewCount: reviewCount, reviews: reviews };
}

// ── Fetch Trustpilot reviews ──────────────────────────────────────────────────
async function fetchTrustpilot(businessName, website) {
  // Two confirmed-real, actively-maintained actors, tried in sequence. Input
  // schemas below were verified against each actor's live build (Apify
  // "actor-builds" input schema) and a real test run:
  //   • automation-lab/trustpilot — required "companyUrls" is an array of
  //     STRINGS (domain or full company URL), NOT an array of {url} objects.
  //     Review cap field is "maxReviewsPerCompany" (not "maxReviews").
  //   • zen-studio/trustpilot-review-scraper — required "businessUrl" is a
  //     single string. Result cap field is "maxResults" (not "maxReviews");
  //     its default is 1000, which made runs scrape for minutes and time out —
  //     capping it small keeps the run fast.
  // Both want a direct company page (trustpilot.com/review/{domain}); neither
  // works from a business name alone, so a known domain is required.
  var domain = (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain) return { data: null, status: 'not_measured' };
  var tpUrl = 'https://www.trustpilot.com/review/' + domain;

  var tpAttempts = [
    { id: 'automation-lab~trustpilot',            input: { companyUrls: [domain], maxReviewsPerCompany: 10, languages: ['en'], includeCompanyInfo: true } },
    { id: 'zen-studio~trustpilot-review-scraper', input: { businessUrl: tpUrl,    maxResults: 10 } }
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

  var company = normalizeTrustpilot(items);

  if (!looksLikeSameBusiness(company.name, company.url, businessName, domain)) {
    console.warn('[apify] Trustpilot result "' + (company.name || 'unknown') + '" does not match "' + businessName + '" — discarded to keep evidence authentic');
    return { data: null, status: 'no_verified_match' };
  }

  return { data: {
    platform:     'trustpilot',
    name:         company.name        || businessName,
    rating:       company.rating      || null,
    reviewCount:  company.reviewCount  || 0,
    ratingLabel:  '',
    url:          company.url          || tpUrl,
    reviews:      company.reviews,
    source:       'apify'
  }, status: 'available' };
}

// ── Fetch Google Maps reviews ─────────────────────────────────────────────────
async function fetchGoogleReviews(businessName, city) {
  var query = businessName + (city ? ' ' + city : '');

  // compass/Google-Maps-Reviews-Scraper — VERIFIED live (2026-08). It takes a
  // Google Maps place OR search URL under "startUrls" and returns a FLAT list
  // of review objects, each of which also carries the place's identity fields:
  //   title (place name), totalScore (place rating), reviewsCount (place total),
  //   address, categoryName, plus per-review stars + text.
  // A Maps SEARCH url ("/maps/search/{query}") resolves to the top matching
  // place, so a place URL/placeId is NOT required up front — the identity guard
  // below then confirms the resolved place actually matches the business.
  // The previously configured powerai/google-map-reviews-scraper was replaced:
  // it returned raw reviews with NO place name/rating/count (so nothing could be
  // verified) and in testing resolved to an unrelated business entirely.
  var searchUrl = 'https://www.google.com/maps/search/' + encodeURIComponent(query);
  var actors = [
    { id: 'compass~Google-Maps-Reviews-Scraper', input: { startUrls: [{ url: searchUrl }], maxReviews: 10, language: 'en' } }
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

  // Place identity lives on each review item (flat list), not a separate header.
  var head = items[0] || {};
  var placeName = head.title || head.placeName || head.name || '';
  // Identity guard: the search URL returns whatever Google ranked first, so we
  // must confirm it is actually this business before trusting its reviews.
  // There is no website field on this actor's output — match on the place name.
  if (!looksLikeSameBusiness(placeName, '', businessName, '')) {
    console.warn('[apify] Google result "' + (placeName || 'unknown') + '" does not match "' + businessName + '" — discarded to keep evidence authentic');
    return { data: null, status: 'no_verified_match' };
  }

  var reviews = items.filter(function(r) {
    return r && r.text;
  }).slice(0, 5).map(function(r) {
    var stars = r.stars != null ? r.stars : r.rating;
    return (stars != null ? stars + '/5: ' : '') + String(r.text || '').slice(0, 200);
  });

  return { data: {
    platform:    'google_reviews',
    name:        placeName          || businessName,
    rating:      head.totalScore != null ? Number(head.totalScore) : null,
    reviewCount: Number(head.reviewsCount || 0) || 0,
    address:     head.address        || '',
    category:    head.categoryName   || '',
    website:     head.website        || '',
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
