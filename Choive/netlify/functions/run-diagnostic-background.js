// run-diagnostic-background.js
// CHOIVE™ background diagnostic engine
// Stage 1: collect evidence — Stage 2: score — Stage 3: save
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPER_API_KEY, ANTHROPIC_API_KEY
const { updateStatus, saveEvidence, saveResult, saveError } = require('./lib/supabase');
const { searchSerper, inferOfficialSite, normalizeUrl } = require('./lib/serper');
const { fetchWebsiteText, fetchCompetitorText } = require('./lib/fetchWebsite');
const { scoreWithClaude } = require('./lib/claude');
const { hasValidShape, buildSafeOutput } = require('./lib/validators');
const { fetchSocialEvidence, buildSocialText } = require('./lib/social');
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
    const name        = safeStr(input.name);
    const category    = safeStr(input.category);
    const city        = safeStr(input.city);
    const website     = safeStr(input.website);
    const description = safeStr(input.description);
    if (!jobId)                   throw new Error('Missing jobId');
    if (!name || !category || !city) throw new Error('Missing required input fields');
    await updateStatus(jobId, 'collecting_evidence', 'collecting_evidence').catch(() => {});
    let serperPayload = { results: [], knowledgeGraph: null, searchText: '', kgText: '' };
    let websiteText   = '';
    let inferredSite  = '';
    let visibilityPos = -1;
    const [serperSettled, webSettled] = await Promise.allSettled([
      searchSerper(name, category, city),
      website ? fetchWebsiteText(website) : Promise.resolve('')
    ]);
    if (serperSettled.status === 'fulfilled') {
      serperPayload = serperSettled.value;
    } else {
      console.warn('[' + jobId + '] Serper failed:', serperSettled.reason?.message);
    }
    if (webSettled.status === 'fulfilled') {
      websiteText = webSettled.value || '';
    } else {
      console.warn('[' + jobId + '] Website fetch failed:', webSettled.reason?.message);
    }
    inferredSite = inferOfficialSite(website, serperPayload, name);
    if (!websiteText && inferredSite && inferredSite !== website) {
      websiteText = await fetchWebsiteText(inferredSite).catch(() => '');
    }
    const targetDomain = normalizeUrl(website || '');
    if (targetDomain) {
      visibilityPos = (serperPayload.results || []).findIndex(
        r => normalizeUrl(r.link || '') === targetDomain
      );
    }
    const evidence = {
      name, category, city, website, description,
      inferredOfficialSite: inferredSite || '',
      websiteText:          websiteText  || '',
      searchText:           serperPayload.searchText   || 'No search results returned.',
      kgText:               serperPayload.kgText       || 'None',
      visibilityPosition:   visibilityPos,
      competitors:          serperPayload.competitors   || [],
      socialSignals:        serperPayload.socialSignals || {},
      summaries:            serperPayload.summaries     || {},
      collectedAt:          new Date().toISOString()
    };
    await saveEvidence(jobId, evidence).catch(err =>
      console.warn('[' + jobId + '] saveEvidence failed:', err.message)
    );
    // Fetch social media pages detected in search results
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

    // Fetch competitor homepage if one was identified
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
    console.log('[' + jobId + '] Score:', finalResult.overallScore, '| Verdict:', finalResult.verdictLevel);
    await saveResult(jobId, finalResult);
    console.log('[' + jobId + '] Diagnostic complete.');
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, jobId }) };
  } catch (err) {
    console.error('run-diagnostic-background error:', err.message);
    if (jobId) await saveError(jobId, err.message).catch(() => {});
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
