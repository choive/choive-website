// run-diagnostic-background.js
// CHOIVE™ background diagnostic engine
// Stage 1: collect evidence — Stage 2: score — Stage 3: save
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPER_API_KEY, ANTHROPIC_API_KEY
const { updateStatus, saveEvidence, saveResult, saveError } = require('./lib/supabase');
const { searchSerper, searchCompetitors, inferOfficialSite, normalizeUrl } = require('./lib/serper');
const { fetchWebsiteText, fetchCompetitorText, fetchReviewPages, buildReviewText } = require('./lib/fetchWebsite');
const { scoreWithClaude, inferCategory } = require('./lib/claude');
const { hasValidShape, buildSafeOutput } = require('./lib/validators');
const { fetchSocialEvidence, buildSocialText } = require('./lib/social');
const { fetchApifyEvidence }   = require('./lib/apify');
const { generateDeliverables } = require('./lib/deliverables');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function safeStr(v) { return typeof v === 'string' ? v.trim() : ''; }

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  let jobId;
  try {
    const body  = JSON.parse(event.body || '{}');
    jobId       = safeStr(body.jobId);
    const input = body.input && typeof body.input === 'object' ? body.input : {};

    const name             = safeStr(input.name);
    const category         = safeStr(input.category);
    const city             = safeStr(input.city);
    const website          = safeStr(input.website);
    const description      = safeStr(input.description);
    const knownCompetitors = safeStr(input.knownCompetitors);

    if (!jobId)                      throw new Error('Missing jobId');
    if (!name || !category || !city) throw new Error('Missing required input fields');

    await updateStatus(jobId, 'collecting_evidence', 'collecting_evidence').catch(() => {});

    // ── STAGE 1: PARALLEL EVIDENCE COLLECTION ────────────────────────────────
    let serperPayload  = { results: [], knowledgeGraph: null, searchText: '', kgText: '' };
    let websiteText    = '';
    let websiteSignals = {};   // ← structured ground truth from fetchWebsite
    let inferredSite   = '';
    let visibilityPos  = -1;

    const [serperSettled, webSettled] = await Promise.allSettled([
      searchSerper(name, category, city),
      website ? fetchWebsiteText(website) : Promise.resolve({ text: '', signals: {} })
    ]);

    if (serperSettled.status === 'fulfilled') {
      serperPayload = serperSettled.value;
    } else {
      console.warn('[' + jobId + '] Serper failed:', serperSettled.reason?.message);
    }

    if (webSettled.status === 'fulfilled') {
      // fetchWebsiteText now returns { text, signals }
      var webResult   = webSettled.value || {};
      websiteText     = webResult.text    || '';
      websiteSignals  = webResult.signals || {};
    } else {
      console.warn('[' + jobId + '] Website fetch failed:', webSettled.reason?.message);
    }

    inferredSite = inferOfficialSite(website, serperPayload, name);

    // If the primary website fetch failed, try the inferred site
    if (!websiteText && inferredSite && inferredSite !== website) {
      var fallbackResult = await fetchWebsiteText(inferredSite).catch(function() {
        return { text: '', signals: {} };
      });
      websiteText    = fallbackResult.text    || '';
      websiteSignals = fallbackResult.signals || {};
    }

    const targetDomain = normalizeUrl(website || '');
    if (targetDomain) {
      visibilityPos = (serperPayload.results || []).findIndex(
        r => normalizeUrl(r.link || '') === targetDomain
      );
    }

    const evidence = {
      name, category, city, website, description, knownCompetitors,
      inferredOfficialSite: inferredSite   || '',
      websiteText:          websiteText    || '',
      websiteSignals:       websiteSignals,   // ← structured signals attached here
      searchText:           serperPayload.searchText   || 'No search results returned.',
      kgText:               serperPayload.kgText       || 'None',
      visibilityPosition:   visibilityPos,
      competitors:          serperPayload.competitors   || [],
      socialSignals:        serperPayload.socialSignals || {},
      summaries:            serperPayload.summaries     || {},
      collectedAt:          new Date().toISOString(),
    };

    await saveEvidence(jobId, evidence).catch(err =>
      console.warn('[' + jobId + '] saveEvidence failed:', err.message)
    );

    // ── Social media pages ────────────────────────────────────────────────────
    var socialEvidence = {};
    var socialText     = 'No social media pages found.';
    try {
      socialEvidence = await fetchSocialEvidence(serperPayload.results || [], name);
      socialText     = buildSocialText(socialEvidence);
      evidence['socialEvidence'] = socialEvidence;
      evidence['socialText']     = socialText;
      console.log('[' + jobId + '] Social platforms fetched:', Object.keys(socialEvidence).join(', ') || 'none');
    } catch (err) {
      console.warn('[' + jobId + '] Social fetch failed:', err.message);
    }

    // ── Review platform pages ─────────────────────────────────────────────────
    var reviewPages = {};
    var reviewText  = 'No review platform pages found.';
    try {
      reviewPages = await fetchReviewPages(serperPayload.results || []);
      reviewText  = buildReviewText(reviewPages);
      evidence['reviewPages'] = reviewPages;
      evidence['reviewText']  = reviewText;
      var reviewKeys = Object.keys(reviewPages);
      if (reviewKeys.length > 0) {
        console.log('[' + jobId + '] Review pages fetched:', reviewKeys.join(', '));
        // Signal: review platform presence confirmed by actual page fetch
        if (!websiteSignals.confirmedReviewPlatforms) {
          websiteSignals.confirmedReviewPlatforms = reviewKeys;
          evidence.websiteSignals = websiteSignals;
        }
      }
    } catch (err) {
      console.warn('[' + jobId + '] Review fetch failed:', err.message);
    }

    // ── Apify review evidence ─────────────────────────────────────────────────
    var apifyResult = { apifyText: '', trustpilot: null, googleReviews: null };
    try {
      apifyResult = await fetchApifyEvidence(name, city, website);
      if (apifyResult.apifyText) {
        evidence['apifyText']     = apifyResult.apifyText;
        evidence['trustpilot']    = apifyResult.trustpilot;
        evidence['googleReviews'] = apifyResult.googleReviews;
        // Attach confirmed review data to signals for deterministic use
        if (apifyResult.trustpilot) {
          websiteSignals.trustpilotRating      = apifyResult.trustpilot.rating      || null;
          websiteSignals.trustpilotReviewCount = apifyResult.trustpilot.reviewCount || 0;
        }
        if (apifyResult.googleReviews) {
          websiteSignals.googleRating      = apifyResult.googleReviews.rating      || null;
          websiteSignals.googleReviewCount = apifyResult.googleReviews.reviewCount || 0;
        }
        evidence.websiteSignals = websiteSignals;
        console.log('[' + jobId + '] Apify evidence collected');
      }
    } catch (err) {
      console.warn('[' + jobId + '] Apify failed:', err.message);
    }

    // ── Competitor homepage fetch ─────────────────────────────────────────────
    var competitorPageText = '';
    if (serperPayload.competitors && serperPayload.competitors.length > 0) {
      var topComp = serperPayload.competitors[0];
      if (topComp && topComp['domain']) {
        competitorPageText = await fetchCompetitorText(topComp['domain']).catch(function() { return ''; });
        if (competitorPageText) {
          evidence['competitorPageText'] = competitorPageText;
          evidence['competitorDomain']   = topComp['domain'];
          console.log('[' + jobId + '] Fetched competitor: ' + topComp['domain']);
        }
      }
    }

    // ── STAGE 1b: CATEGORY INFERENCE + SECOND-PASS COMPETITOR SEARCH ─────────
    var inferredCat = category;
    try {
      var catResult = await inferCategory(name, category, evidence['websiteText'], evidence['searchText']);
      if (catResult) {
        inferredCat = catResult;
        if (catResult !== category) {
          console.log('[' + jobId + '] Inferred category: ' + inferredCat);
        }
        evidence['inferredCategory'] = inferredCat;
      }
    } catch (err) {
      console.warn('[' + jobId + '] Category inference failed:', err.message);
    }

    try {
      var compSearch = await searchCompetitors(name, inferredCat, city, knownCompetitors);
      if (compSearch.competitors && compSearch.competitors.length > 0) {
        var existingDomains = (evidence['competitors'] || []).map(function(c) { return c['domain']; });
        var newComps = compSearch.competitors.filter(function(c) { return existingDomains.indexOf(c['domain']) === -1; });
        evidence['competitors'] = newComps.concat(evidence['competitors'] || []).slice(0, 5);
        console.log('[' + jobId + '] Second-pass competitors:', evidence['competitors'].map(function(c) { return c['domain']; }).join(', '));
      }
      if (compSearch.searchText) {
        evidence['searchText'] = evidence['searchText'] + '\n\nSECOND-PASS COMPETITOR SEARCH (inferred category: ' + inferredCat + '):\n' + compSearch.searchText;
      }
    } catch (err) {
      console.warn('[' + jobId + '] Second-pass competitor search failed:', err.message);
    }

    // ── STAGE 2: SCORING ──────────────────────────────────────────────────────
    await updateStatus(jobId, 'scoring', 'scoring').catch(() => {});

    let rawOutput;
    try {
      rawOutput = await scoreWithClaude(evidence);
    } catch (err) {
      console.error('[' + jobId + '] Claude scoring failed:', err.message);
      await saveError(jobId, 'Scoring failed: ' + err.message).catch(() => {});
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: false, jobId }) };
    }

    if (!hasValidShape(rawOutput)) {
      console.warn('[' + jobId + '] Claude output shape invalid — applying safe normalization');
    }

    const finalResult = buildSafeOutput(rawOutput);

    // Merge evidence-level fields not returned by Claude into final result
    if (evidence['socialSignals'] && Object.keys(evidence['socialSignals']).length > 0) {
      finalResult['socialSignals'] = evidence['socialSignals'];
    }
    if (evidence['summaries'] && Object.keys(evidence['summaries']).length > 0) {
      finalResult['summaries'] = evidence['summaries'];
    }
    if (evidence['reviewText'])       finalResult['reviewText']       = evidence['reviewText'];
    if (evidence['apifyText'])        finalResult['apifyText']        = evidence['apifyText'];
    if (evidence['inferredCategory']) finalResult['inferredCategory'] = finalResult['inferredCategory'] || evidence['inferredCategory'];

    console.log('[' + jobId + '] Score:', finalResult.overallScore, '| Verdict:', finalResult.verdictLevel);

    // ── STAGE 3: DELIVERABLES ─────────────────────────────────────────────────
    try {
      var deliverables = generateDeliverables(evidence, finalResult);
      finalResult['deliverables'] = deliverables;
    } catch (err) {
      console.warn('[' + jobId + '] Deliverables failed:', err.message);
    }

    await saveResult(jobId, finalResult);
    console.log('[' + jobId + '] Diagnostic complete.');
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, jobId }) };

  } catch (err) {
    console.error('run-diagnostic-background error:', err.message);
    if (jobId) await saveError(jobId, err.message).catch(() => {});
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
