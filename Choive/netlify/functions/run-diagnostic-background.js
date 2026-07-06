// run-diagnostic-background.js
// CHOIVE™ background diagnostic engine
// Stage 1: collect evidence — Stage 2: score — Stage 3: save
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPER_API_KEY, ANTHROPIC_API_KEY
const { updateStatus, saveEvidence, saveResult, saveError, getCachedEvidence, buildFingerprint, getPreviousCompetitor, getPreviousResult } = require('./lib/supabase');
const { searchSerper, searchCompetitors, inferOfficialSite, normalizeUrl } = require('./lib/serper');
const { fetchWebsiteText, fetchCompetitorText, fetchReviewPages, buildReviewText } = require('./lib/fetchWebsite');
const { scoreWithClaude, inferCategory } = require('./lib/claude');
const { hasValidShape, buildSafeOutput } = require('./lib/validators');
const { fetchSocialEvidence, buildSocialText } = require('./lib/social');
const { fetchApifyEvidence }   = require('./lib/apify');
const { generateDeliverables } = require('./lib/deliverables');
const { runSimulation, runBeforeSimulation, runAfterSimulation } = require('./lib/simulation');
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function safeStr(v) { return typeof v === 'string' ? v.trim() : ''; }
// ── VERIFICATION ENGINE ─────────────────────────────────────────────
// Compares this run against the previous completed run for the same business
// and produces a provable delta: score movement, per-pillar movement, and —
// because signals are mechanically confirmed — attributable changes ("llms.txt:
// absent → present"). The measure → prescribe → VERIFY loop no monitoring
// platform closes. Pure function; never throws into the pipeline.
function computeProgressDelta(prevRow, finalResult, evidence) {
  if (!prevRow || !prevRow.result || !finalResult) return null;
  var prev      = prevRow.result;
  var prevScore = Number(prev.score);
  var curScore  = Number(finalResult.score);
  if (!isFinite(prevScore) || !isFinite(curScore)) return null;

  var delta = {
    previousJobId: prevRow.job_id || null,
    previousDate:  prevRow.created_at || null,
    previousScore: prevScore,
    scoreDelta:    curScore - prevScore,
    pillars:       {},
    signals:       [],
    selectionRate: null,
    competitorChange: null
  };

  var pKeys = ['clarity', 'trust', 'difference', 'ease'];
  for (var i = 0; i < pKeys.length; i++) {
    var k  = pKeys[i];
    var pp = prev.pillars && prev.pillars[k] ? Number(prev.pillars[k].score) : NaN;
    var cp = finalResult.pillars && finalResult.pillars[k] ? Number(finalResult.pillars[k].score) : NaN;
    if (isFinite(pp) && isFinite(cp)) delta.pillars[k] = cp - pp;
  }

  var prevSite = (prevRow.evidence && prevRow.evidence.website) || {};
  var curSite  = (evidence && evidence.website) || {};
  var sigMap = [
    ['hasSchema',          'Schema markup'],
    ['hasLlmsTxt',         'llms.txt'],
    ['hasH1',              'H1 tag'],
    ['hasTitle',           'Title tag'],
    ['hasMetaDescription', 'Meta description'],
    ['hasCanonical',       'Canonical tag'],
    ['hasSitemap',         'sitemap.xml'],
    ['hasRobots',          'robots.txt'],
    ['hasOgTags',          'OG tags']
  ];
  for (var s = 0; s < sigMap.length; s++) {
    var key = sigMap[s][0], label = sigMap[s][1];
    var was = prevSite[key] === true, now = curSite[key] === true;
    if (was !== now && (key in prevSite || key in curSite)) {
      delta.signals.push({ label: label, from: was, to: now });
    }
  }

  var prevB = prev.aiSimulation && prev.aiSimulation.before;
  var curB  = (finalResult.aiSimulation && finalResult.aiSimulation.before)
           || ((evidence.aiSimulationBefore || {}).before);
  if (prevB && curB && isFinite(Number(prevB.appearedCount)) && isFinite(Number(curB.appearedCount))) {
    delta.selectionRate = {
      previous: Number(prevB.appearedCount),
      current:  Number(curB.appearedCount),
      total:    Number(curB.totalQueries) || 3
    };
  }

  var prevComp = Array.isArray(prev.competitors) && prev.competitors[0] && prev.competitors[0].name
    ? String(prev.competitors[0].name).trim() : null;
  var curComp = Array.isArray(finalResult.competitors) && finalResult.competitors[0] && finalResult.competitors[0].name
    ? String(finalResult.competitors[0].name).trim() : null;
  if (prevComp && curComp && prevComp.toLowerCase() !== curComp.toLowerCase()) {
    delta.competitorChange = { from: prevComp, to: curComp };
  }

  return delta;
}

// Category fidelity guard: an inferred category that shares no distinctive
// word with the owner's own words has drifted into a different industry —
// the CHOIVE→"AI evaluation platform" bug. Owner's words win on zero overlap.
function categoryFaithful(ownerCategory, inferred) {
  var stop = { the:1, and:1, for:1, with:1, from:1, into:1, that:1, this:1, b2b:1, b2c:1, online:1, platform:1, service:1, services:1, company:1, business:1, tool:1, agency:1, provider:1, global:1 };
  var toks = function(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(function(w) { return w.length > 2 && !stop[w]; });
  };
  var own = toks(ownerCategory);
  if (!own.length) return true;
  var inf = {};
  toks(inferred).forEach(function(w) { inf[w] = 1; });
  for (var i = 0; i < own.length; i++) {
    var w = own[i];
    if (inf[w]) return true;
    // simple stem tolerance: diagnostic/diagnostics, roaster/roasters
    for (var k in inf) { if (k.indexOf(w) === 0 || w.indexOf(k) === 0) return true; }
  }
  return false;
}

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
    const languagePref     = (['de','es','fr','it','nl','pt','pl','tr','sv','da','ja','ko','zh','en','ar','ru','hi','id'].indexOf(safeStr(input.language).toLowerCase()) !== -1) ? safeStr(input.language).toLowerCase() : '';
    if (!jobId)                      throw new Error('Missing jobId');
    if (!name || !category || !city) throw new Error('Missing required input fields');
    await updateStatus(jobId, 'collecting_evidence', 'collecting_evidence').catch(() => {});
    // ── CACHE CHECK — reuse recent evidence for the same business ────────────
    const fingerprint = buildFingerprint({ name, category, city });
    const cached = await getCachedEvidence(fingerprint, 24).catch(() => null);
    let evidence = null;

    if (cached && cached.evidence) {
      // ── REALITY CHECK — the cache is valid only if the website hasn't changed.
      // One cheap fetch. If the customer implemented fixes since the cached run
      // (new llms.txt, new H1, new schema types...), the cache is stale by
      // definition: bust it and re-measure everything NOW, so verification
      // never makes someone wait a day to see their own work count.
      var cacheValid = true;
      if (website) {
        try {
          var freshSite = await fetchWebsiteText(website);
          var freshSig  = (freshSite && freshSite.signals) || {};
          var cachedSig = (cached.evidence && cached.evidence.website) || {};
          var sigKeys = ['hasSchema','hasLlmsTxt','hasH1','hasTitle','hasMetaDescription','hasCanonical','hasSitemap','hasRobots','hasOgTags'];
          var changed = sigKeys.filter(function(k) { return (freshSig[k] === true) !== (cachedSig[k] === true); });
          var freshTypes  = Array.isArray(freshSig.schemaTypes)  ? freshSig.schemaTypes.length  : 0;
          var cachedTypes = Array.isArray(cachedSig.schemaTypes) ? cachedSig.schemaTypes.length : 0;
          if (freshTypes !== cachedTypes) changed.push('schemaTypes(' + cachedTypes + '\u2192' + freshTypes + ')');
          if (changed.length > 0) {
            cacheValid = false;
            console.log('[' + jobId + '] Cache busted \u2014 website changed since cached run: ' + changed.join(', '));
          }
        } catch (err) {
          console.warn('[' + jobId + '] Cache revalidation fetch failed, keeping cache:', err.message);
        }
      }
      if (cacheValid) {
        console.log('[' + jobId + '] Using cached evidence from job ' + cached.job_id + ' (within 24h, website unchanged)');
        evidence = cached.evidence;
        await saveEvidence(jobId, evidence).catch(err =>
          console.warn('[' + jobId + '] saveEvidence (cached) failed:', err.message)
        );
      }
    }
    if (!evidence) {
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
        evidence = {
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
        if (catResult && !categoryFaithful(category, catResult)) {
          console.warn('[' + jobId + '] Inferred category "' + catResult + '" shares no distinctive word with owner category "' + category + '" — industry drift, keeping owner\u2019s words');
          catResult = category;
        }
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

      // ── STAGE 1c: AI SELECTION GROUND TRUTH (before-simulation) ───────────
      // Runs the three real "who would you recommend" queries BEFORE scoring,
      // so the dominant competitor is chosen from what AI actually recommends
      // today — not from whoever happens to SEO-rank in search evidence.
      // Saved inside evidence so it caches with the fingerprint: competitor
      // identity stays stable across runs within the cache window.
      var cachedSimLang = evidence['aiSimulationBefore'] && evidence['aiSimulationBefore'].before
        && evidence['aiSimulationBefore'].before.language;
      if (!evidence['aiSimulationBefore'] || (languagePref && cachedSimLang !== languagePref)) {
        try {
          var simBefore = await runBeforeSimulation({
            language:         languagePref || undefined,
            name:             name,
            category:         category,
            city:             city,
            description:      description,
            inferredCategory: evidence['inferredCategory'] || category
          });
          if (simBefore && simBefore.before) {
            evidence['aiSimulationBefore'] = simBefore;
            console.log('[' + jobId + '] Before-simulation: appeared ' + simBefore.before.appearedCount + '/3');
          }
        } catch (err) {
          console.warn('[' + jobId + '] Before-simulation failed:', err.message);
        }
      }

      // ── FINAL EVIDENCE SAVE — persist the fully enriched evidence ───────────
      // The early save above stores only the initial Serper + website snapshot.
      // Everything collected after it (social, review pages, Apify, competitor
      // homepage, inferred category, second-pass competitors) must be in the
      // saved copy — otherwise cached runs within 24h score with LESS evidence
      // than fresh runs, producing inconsistent scores and fewer competitors.
      await saveEvidence(jobId, evidence).catch(err =>
        console.warn('[' + jobId + '] saveEvidence (final) failed:', err.message)
      );

    }

    // ── COMPETITOR STABILITY — look up previously identified competitor ────────
    // This prevents drift between runs (e.g. Semrush one day, Profound the next)
    // by giving Claude a strong prior anchored to the last verified run.
    try {
      var previousCompetitor = await getPreviousCompetitor(fingerprint);
      if (previousCompetitor) {
        evidence['previousCompetitor'] = previousCompetitor;
        console.log('[' + jobId + '] Previous competitor: ' + previousCompetitor);
      }
    } catch (err) {
      console.warn('[' + jobId + '] Previous competitor lookup failed:', err.message);
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
    // ── COMPETITOR ENFORCEMENT (code-level) ───────────────────────────
    // The dedicated selection stage's decision is final. If the scoring model
    // ignored the directive, this overwrites the result — a prompt can be
    // disobeyed; an assignment cannot. Survives poisoned caches and priors.
    try {
      var cd = evidence['competitorDecision'];
      if (cd && cd.realCompetitor) {
        if (!Array.isArray(finalResult.competitors)) finalResult.competitors = [];
        var comps = finalResult.competitors;
        var normName = function(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
        var target = normName(cd.realCompetitor);
        var idx = comps.findIndex(function(c) { return c && normName(c.name) === target; });
        if (idx === 0) {
          // scoring model obeyed — nothing to do
        } else if (idx > 0) {
          var entry = comps.splice(idx, 1)[0];
          comps.unshift(entry);
          console.warn('[' + jobId + '] Competitor enforcement: promoted ' + cd.realCompetitor + ' from position ' + idx);
        } else {
          comps.unshift({
            name:         cd.realCompetitor,
            advantage:    cd.reason || 'Direct head-to-head competitor in this category.',
            gapLocation:  '',
            closeGap:     '',
            evidence:     'Identified by the dedicated competitor-selection stage (source: ' + cd.source + ').'
              + (cd.categoryUnowned ? ' AI answers for this category currently name no true same-category player — the category answer is unowned.' : ''),
            queryContext: cd.source
          });
          console.warn('[' + jobId + '] Competitor enforcement: inserted ' + cd.realCompetitor + ' (scoring model had ignored the decision)');
        }
        // who AI actually names — ensure it is present as displacement evidence
        if (cd.aiRecommends && normName(cd.aiRecommends) !== target) {
          var hasAI = comps.some(function(c) { return c && normName(c.name) === normName(cd.aiRecommends); });
          if (!hasAI) {
            comps.splice(1, 0, {
              name:         cd.aiRecommends,
              advantage:    'This is the business AI currently recommends when buyers ask for this category.',
              gapLocation:  '',
              closeGap:     '',
              evidence:     'Named in the AI selection ground truth — the real recommendation queries run for this diagnostic.',
              queryContext: 'ai-ground-truth'
            });
          }
          finalResult.competitors = comps.slice(0, 3);
        }
      }
    } catch (err) {
      console.warn('[' + jobId + '] Competitor enforcement failed:', err.message);
    }
    // Expose the selection decision so the result page can label each name by
    // its true source — the AI-displacement banner may only show aiRecommends.
    try {
      var cdX = evidence['competitorDecision'];
      if (cdX) {
        finalResult['competitorDecision'] = {
          selectionVersion: cdX.selectionVersion || null,
          realCompetitor:  cdX.realCompetitor  || null,
          aiRecommends:    cdX.aiRecommends    || null,
          globalBenchmark: cdX.globalBenchmark || null,
          categoryUnowned: cdX.categoryUnowned === true
        };
      }
    } catch (e) {}
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
    // ── STAGE 3b: AI SIMULATION ──────────────────────────────────────────────
    // Runs the before/after query simulation server-side and saves it with the
    // result, so the paid report always has real word-for-word queries and the
    // free result page shows the exact same data. Failure here never breaks
    // the diagnostic — the report has a graceful fallback.
    try {
      var pDiff  = (finalResult.pillars && finalResult.pillars.difference) || {};
      var pTrust = (finalResult.pillars && finalResult.pillars.trust)      || {};
      var simData = null;
      var preBefore = evidence['aiSimulationBefore'];
      if (preBefore && preBefore.before) {
        try {
          var afterHalf = await runAfterSimulation({
            language:         (preBefore.before && preBefore.before.language) || undefined,
            name:             name,
            category:         category,
            city:             city,
            inferredCategory: finalResult['inferredCategory'] || evidence['inferredCategory'] || category,
            differentiator:   String(pDiff.evidence  || '').slice(0, 200),
            trustSignal:      String(pTrust.evidence || '').slice(0, 200)
          });
          if (afterHalf && afterHalf.after) {
            simData = {
              name:     preBefore.name,
              category: preBefore.category,
              before:   preBefore.before,
              after:    afterHalf.after
            };
          }
        } catch (err) {
          console.warn('[' + jobId + '] After-simulation failed, falling back to full run:', err.message);
        }
      }
      if (!simData) {
        simData = await runSimulation({
          name:             name,
          category:         category,
          city:             city,
          inferredCategory: finalResult['inferredCategory'] || evidence['inferredCategory'] || category,
          differentiator:   String(pDiff.evidence  || '').slice(0, 200),
          trustSignal:      String(pTrust.evidence || '').slice(0, 200)
        });
      }
      if (simData && simData.before && simData.after) {
        finalResult['aiSimulation'] = simData;
        console.log('[' + jobId + '] AI simulation: before ' + simData.before.appearedCount + '/3, after ' + simData.after.appearedCount + '/3');
      }
    } catch (err) {
      console.warn('[' + jobId + '] AI simulation failed:', err.message);
    }
    // ── VERIFICATION: compare against the previous completed run ───────────
    try {
      var prevRow = await getPreviousResult(fingerprint);
      var progressDelta = computeProgressDelta(prevRow, finalResult, evidence);
      if (progressDelta) {
        finalResult['progressDelta'] = progressDelta;
        console.log('[' + jobId + '] Progress vs previous run: '
          + (progressDelta.scoreDelta >= 0 ? '+' : '') + progressDelta.scoreDelta
          + ' | signals changed: ' + progressDelta.signals.length);
      }
    } catch (err) {
      console.warn('[' + jobId + '] Verification delta failed:', err.message);
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
