// run-diagnostic-background.js
// CHOIVE™ background engine
// Stage 1: collect evidence
// Stage 2: score with Claude
// Stage 3: save final result
//
// ENV:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SERPER_API_KEY
// ANTHROPIC_API_KEY

const {
  updateStatus,
  saveEvidence,
  saveResult,
  markDiagnosticFailed
} = require('./lib/supabase');
const { searchSerper, inferOfficialSite, normalizeUrl } = require('./lib/serper');
const { fetchWebsiteText } = require('./lib/fetchWebsite');
const { scoreWithClaude } = require('./lib/claude');
const { hasValidShape, buildSafeOutput } = require('./lib/validators');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: 'Method Not Allowed'
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: 'Invalid JSON'
    };
  }

  const jobId = safeString(body.jobId);
  const input = body.input && typeof body.input === 'object' ? body.input : {};

  const name = safeString(input.name);
  const category = safeString(input.category);
  const city = safeString(input.city);
  const website = safeString(input.website);
  const description = safeString(input.description);

  if (!jobId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: 'Missing jobId'
    };
  }

  if (!name || !category || !city) {
    await markDiagnosticFailed(jobId, {
      message: 'Missing required business input for diagnostic run'
    }).catch(() => {});

    return {
      statusCode: 400,
      headers: corsHeaders,
      body: 'Missing required input'
    };
  }

  // ── STAGE 1: COLLECT EVIDENCE ─────────────────────────────────────────

  try {
    await updateStatus(jobId, 'collecting_evidence', 'collecting_evidence');
  } catch (err) {
    console.error(`[${jobId}] Failed to update status to collecting_evidence:`, err.message);
  }

  let serperPayload = { results: [], knowledgeGraph: null, searchText: '', kgText: 'None' };
  let inferredOfficialSite = '';
  let websiteText = '';
  let visibilityPosition = -1;

  try {
    const [serperSettled, websiteSettled] = await Promise.allSettled([
      searchSerper(name, category, city),
      website ? fetchWebsiteText(website) : Promise.resolve('')
    ]);

    if (serperSettled.status === 'fulfilled') {
      serperPayload = serperSettled.value;
    } else {
      console.warn(`[${jobId}] Serper failed:`, serperSettled.reason?.message);
    }

    if (websiteSettled.status === 'fulfilled') {
      websiteText = websiteSettled.value || '';
    } else {
      console.warn(`[${jobId}] Website fetch failed:`, websiteSettled.reason?.message);
    }

    inferredOfficialSite = inferOfficialSite(website, serperPayload, name);

    if (!websiteText && inferredOfficialSite && inferredOfficialSite !== website) {
      websiteText = await fetchWebsiteText(inferredOfficialSite).catch(() => '');
    }

    const targetDomain = normalizeUrl(website || '');
    visibilityPosition = targetDomain
      ? (serperPayload.results || []).findIndex(result => normalizeUrl(result.link) === targetDomain)
      : -1;
  } catch (err) {
    console.error(`[${jobId}] Evidence collection failed:`, err.message);

    await markDiagnosticFailed(jobId, {
      message: 'Evidence collection failed',
      detail: err.message
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, jobId })
    };
  }

  const evidence = {
    name,
    category,
    city,
    website,
    description,
    inferredOfficialSite: inferredOfficialSite || '',
    websiteText: websiteText || '',
    searchText: serperPayload.searchText || 'No search results returned.',
    kgText: serperPayload.kgText || 'None',
    visibilityPosition,
    collectedAt: new Date().toISOString()
  };

  try {
    await saveEvidence(jobId, evidence);
  } catch (err) {
    console.error(`[${jobId}] Failed to save evidence:`, err.message);

    await markDiagnosticFailed(jobId, {
      message: 'Evidence save failed',
      detail: err.message
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, jobId })
    };
  }

  // ── STAGE 2: SCORE WITH CLAUDE ────────────────────────────────────────

  let rawOutput;

  try {
    rawOutput = await scoreWithClaude(evidence);
  } catch (err) {
    console.error(`[${jobId}] Claude scoring failed:`, err.message);

    await markDiagnosticFailed(jobId, {
      message: 'Scoring failed',
      detail: err.message
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, jobId })
    };
  }

  if (!hasValidShape(rawOutput)) {
    console.warn(`[${jobId}] Claude output shape invalid — applying safe normalization`);
  }

  const finalResult = buildSafeOutput(rawOutput);

  // ── STAGE 3: SAVE RESULT ──────────────────────────────────────────────

  try {
    await updateStatus(jobId, 'scoring', 'preparing_result').catch(() => {});
    await saveResult(jobId, finalResult);
    console.log(`[${jobId}] Diagnostic complete. Score: ${finalResult.overallScore}`);
  } catch (err) {
    console.error(`[${jobId}] Failed to save result:`, err.message);

    await markDiagnosticFailed(jobId, {
      message: 'Result save failed',
      detail: err.message
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, jobId })
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      ok: true,
      jobId
    })
  };
};
