// run-diagnostic-background.js
// CHOIVE™ background diagnostic engine
// Stage 1: collect evidence — Stage 2: score — Stage 3: save
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPER_API_KEY, ANTHROPIC_API_KEY

const { updateStatus, saveEvidence, saveResult, saveError } = require('./lib/supabase');
const { searchSerper, inferOfficialSite, normalizeUrl } = require('./lib/serper');
const { fetchWebsiteText } = require('./lib/fetchWebsite');
const { scoreWithClaude } = require('./lib/claude');
const { hasValidShape, buildSafeOutput } = require('./lib/validators');

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

    // ── STAGE 1: COLLECT EVIDENCE ──────────────────────────────────────────
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
      searchText:           serperPayload.searchText || 'No search results returned.',
      kgText:               serperPayload.kgText     || 'None',
      visibilityPosition:   visibilityPos,
      collectedAt:          new Date().toISOString()
    };

    await saveEvidence(jobId, evidence).catch(err =>
      console.warn('[' + jobId + '] saveEvidence failed:', err.message)
    );

    // ── STAGE 2: SCORE WITH CLAUDE ─────────────────────────────────────────
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

    // ── STAGE 3: SAVE RESULT ───────────────────────────────────────────────
    await saveResult(jobId, finalResult);
    console.log('[' + jobId + '] Diagnostic complete.');

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, jobId }) };

  } catch (err) {
    console.error('run-diagnostic-background error:', err.message);
    if (jobId) await saveError(jobId, err.message).catch(() => {});
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
