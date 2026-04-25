// ── FUNCTION 2: run-diagnostic-background ────────────────────────────────────
// Background function: Stage 1 (gather) + Stage 2 (judge)
// Runs async — no user-facing timeout pressure
// Stores result in Netlify Blobs when complete

const { updateStatus, saveResult, saveError } = require('./lib/supabase');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

function clampScore(n) {
  return Math.max(0, Math.min(25, Number(n) || 0));
}

function normalizeUrl(url) {
  if (!url) return '';
  return String(url)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function ensureProtocol(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

// ── STAGE 1: GATHER ───────────────────────────────────────────────────────────

async function searchWithSerper(name, category, city) {
  if (!process.env.SERPER_API_KEY) throw new Error('Missing SERPER_API_KEY');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const query = [name, category, city].filter(Boolean).join(' ').trim();
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query, num: 5 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Serper error (${response.status})`);
    const data = await response.json();
    return {
      organic: Array.isArray(data?.organic) ? data.organic.slice(0, 4) : [],
      knowledgeGraph: data?.knowledgeGraph || null
    };
  } catch (error) {
    clearTimeout(timeout);
    return { organic: [], knowledgeGraph: null };
  }
}

async function fetchWebsiteText(url) {
  if (!url) return '';
  const safeUrl = ensureProtocol(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(safeUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) return '';
    const html = await response.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500);
  } catch (_) {
    clearTimeout(timeout);
    return '';
  }
}

async function gatherEvidence(name, category, city, website) {
  // Run Serper + website fetch in parallel
  const [serperResult, earlyWebsiteText] = await Promise.allSettled([
    searchWithSerper(name, category, city),
    website ? fetchWebsiteText(website) : Promise.resolve('')
  ]);

  const serperData = serperResult.status === 'fulfilled'
    ? serperResult.value
    : { organic: [], knowledgeGraph: null };

  const organicResults = serperData.organic || [];
  const targetDomain = normalizeUrl(website || '');

  const inferredOfficialSite =
    website ||
    organicResults.find(r => {
      const linkDomain = normalizeUrl(r?.link || '');
      if (!linkDomain) return false;
      return (
        linkDomain.includes(normalizeUrl(name).replace(/\s+/g, '')) ||
        (serperData.knowledgeGraph?.website &&
          normalizeUrl(serperData.knowledgeGraph.website) === linkDomain)
      );
    })?.link ||
    serperData.knowledgeGraph?.website ||
    '';

  let websiteText = earlyWebsiteText.status === 'fulfilled' ? earlyWebsiteText.value : '';
  if (!websiteText && inferredOfficialSite && inferredOfficialSite !== website) {
    websiteText = await fetchWebsiteText(inferredOfficialSite);
  }

  const searchEvidence = organicResults
    .map((r, i) => `${i + 1}. ${(r.title || '').slice(0, 90)} — ${(r.snippet || '').slice(0, 140)}`)
    .join('\n');

  const knowledgeGraphEvidence = serperData.knowledgeGraph
    ? `Title: ${serperData.knowledgeGraph.title || ''}; Type: ${serperData.knowledgeGraph.type || ''}; Website: ${serperData.knowledgeGraph.website || ''}`
    : 'None';

  const visibilityPosition = targetDomain
    ? organicResults.findIndex(r => normalizeUrl(r?.link || '') === targetDomain)
    : -1;

  return {
    inferredOfficialSite,
    websiteText,
    searchEvidence,
    knowledgeGraphEvidence,
    visibilityPosition,
    organicCount: organicResults.length
  };
}

// ── STAGE 2: JUDGE ────────────────────────────────────────────────────────────

async function scoreWithClaude(input, evidence) {
  const { name, category, city, website, description } = input;
  const {
    inferredOfficialSite,
    websiteText,
    searchEvidence,
    knowledgeGraphEvidence,
    visibilityPosition
  } = evidence;

  const externalContext = `
BUSINESS INPUT:
Name: ${name}
Category: ${category}
Location: ${city}
Website entered by user: ${website || 'not provided'}
Description: ${description || ''}
INFERRED OFFICIAL WEBSITE:
${inferredOfficialSite || 'not found'}
KNOWLEDGE GRAPH:
${knowledgeGraphEvidence}
SEARCH RESULTS:
${searchEvidence || 'No search results returned.'}
WEBSITE CONTENT:
${websiteText || 'No website content available.'}
VISIBILITY:
Entered website appears in results: ${visibilityPosition !== -1 ? 'YES' : 'NO'}
First appearance position: ${visibilityPosition !== -1 ? visibilityPosition + 1 : 'Not found'}
`;

  const prompt = `
${externalContext}
You are CHOIVE™ — a decision intelligence engine.
Judge how strongly this business is positioned to be chosen.
Rules:
- Use the evidence above only.
- Search results are third-party evidence.
- Website content is first-party evidence.
- If no website is available, do not treat that as automatic failure.
- Do not invent facts.
- If evidence is weak, lower confidence.
First determine:
1. what the business is
2. who chooses it
3. whether it is B2B, B2C, platform, service, product, or infrastructure
4. where it should realistically compete
If the business is B2B or infrastructure, do not penalize it for weak consumer visibility.
CHOIVE PRINCIPLE:
Businesses are not chosen because they are the best.
They are chosen because they create the least doubt.
Score 4 pillars (0-25 each):
- Clarity = how clearly the business is defined and understood
- Trust = how credible and verifiable it appears
- Difference = how clearly it stands apart from alternatives
- Ease = how likely it is to be included and chosen in a real decision moment
If website content clearly explains the business, clarity must stay high.
If evidence shows real clients, partnerships, coverage, or scale, trust must stay moderate to high.
Competitive positioning tier — choose one: dominant, strong, upper_mid, mid, weak, absent
Return one short signature line (3-6 words, final, decision-state based).
Decision state — choose one: not_seen, seen_not_considered, considered_not_chosen, trusted_not_chosen, chosen_by_default
summaryParagraph — exactly 3 sentences:
- Sentence 1 must start: "This business is not the obvious choice because..."
- Sentence 2 states the reason simply
- Sentence 3 states the consequence
Each pillar finding — one short sentence, 3-6 words, no commas, no explanation, must feel final.
Return ONLY valid JSON:
{
  "overallScore": 0,
  "verdictHeadline": "",
  "verdictLevel": "absent",
  "signatureLine": "",
  "decisionState": "",
  "summaryParagraph": "",
  "businessUnderstanding": "",
  "marketPosition": { "tier": "", "label": "", "explanation": "" },
  "pillars": {
    "clarity": { "score": 0, "finding": "" },
    "trust": { "score": 0, "finding": "" },
    "difference": { "score": 0, "finding": "" },
    "ease": { "score": 0, "finding": "" }
  },
  "platformCoverage": {
    "chatgpt": { "status": "absent", "detail": "" },
    "perplexity": { "status": "absent", "detail": "" },
    "gemini": { "status": "absent", "detail": "" },
    "claude": { "status": "absent", "detail": "" }
  },
  "evidenceNarrative": "",
  "actions": [
    { "priority": "critical", "title": "", "body": "" },
    { "priority": "critical", "title": "", "body": "" },
    { "priority": "high", "title": "", "body": "" },
    { "priority": "medium", "title": "", "body": "" }
  ]
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1200,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `Anthropic error (${response.status})`);

    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('')
      .trim();

    const clean = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();

    try {
      return JSON.parse(clean);
    } catch (_) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Could not parse Claude response');
    }
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

// ── SAFE OUTPUT ───────────────────────────────────────────────────────────────

function buildSafeOutput(output) {
  const fp = { score: 0, finding: 'Insufficient data.' };
  const fpl = { status: 'absent', detail: 'No data available.' };

  const safe = {
    overallScore: typeof output?.overallScore === 'number' ? output.overallScore : 0,
    verdictHeadline: output?.verdictHeadline || 'Diagnostic incomplete',
    verdictLevel: output?.verdictLevel || 'absent',
    signatureLine: output?.signatureLine || 'Present — but not chosen.',
    decisionState: output?.decisionState || 'considered_not_chosen',
    summaryParagraph: output?.summaryParagraph || 'The diagnostic could not fully assess this business.',
    businessUnderstanding: output?.businessUnderstanding || '',
    marketPosition: output?.marketPosition || { tier: 'unknown', label: 'Unknown position', explanation: '' },
    evidenceNarrative: output?.evidenceNarrative || 'No evidence narrative available.',
    pillars: {
      clarity:    output?.pillars?.clarity    || { ...fp },
      trust:      output?.pillars?.trust      || { ...fp },
      difference: output?.pillars?.difference || { ...fp },
      ease:       output?.pillars?.ease       || { ...fp }
    },
    platformCoverage: {
      chatgpt:    output?.platformCoverage?.chatgpt    || { ...fpl },
      perplexity: output?.platformCoverage?.perplexity || { ...fpl },
      gemini:     output?.platformCoverage?.gemini     || { ...fpl },
      claude:     output?.platformCoverage?.claude     || { ...fpl }
    },
    actions: Array.isArray(output?.actions) && output.actions.length > 0
      ? output.actions
      : [{ priority: 'critical', title: 'Retry diagnostic', body: 'The engine did not return a complete result. Please try again.' }],
    displacement: {
      competitorName:  output?.displacement?.competitorName  || null,
      competitorWhy:   output?.displacement?.competitorWhy   || null,
      competitorQuery: output?.displacement?.competitorQuery || null
    }
  };

  // Clamp and recalculate
  const c = clampScore(safe.pillars.clarity.score);
  const t = clampScore(safe.pillars.trust.score);
  const d = clampScore(safe.pillars.difference.score);
  const e = clampScore(safe.pillars.ease.score);
  safe.pillars.clarity.score = c;
  safe.pillars.trust.score = t;
  safe.pillars.difference.score = d;
  safe.pillars.ease.score = e;
  safe.overallScore = c + t + d + e;

  const marketTier = safe.marketPosition?.tier || '';
  if (safe.overallScore <= 30) {
    safe.verdictLevel = 'absent';
    safe.verdictHeadline = 'Not the obvious choice — losing decisions';
  } else if (safe.overallScore <= 55 || e < 12 || ['upper_mid','mid','weak','absent','unknown'].includes(marketTier)) {
    safe.verdictLevel = 'weak';
    safe.verdictHeadline = 'Not consistently the obvious choice — losing opportunities';
  } else {
    safe.verdictLevel = 'present';
    safe.verdictHeadline = 'The obvious choice — winning decisions';
  }

  return safe;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  let jobId;
  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    const { name, category, city, website, description } = body;

    if (!jobId) throw new Error('Missing jobId');

    // Stage 1: Gather evidence
    await updateStatus(jobId, 'collecting_evidence', 'gathering');
    let evidence;
    try {
      evidence = await gatherEvidence(name, category, city, website);
    } catch (err) {
      await saveError(jobId, 'Evidence gathering failed: ' + err.message);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: false }) };
    }

    // Stage 2: Score with Claude
    await updateStatus(jobId, 'scoring', 'scoring');
    let rawOutput;
    try {
      rawOutput = await scoreWithClaude(
        { name, category, city, website, description },
        evidence
      );
    } catch (err) {
      await saveError(jobId, 'Scoring failed: ' + err.message);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: false }) };
    }

    console.log('[CHOIVE] displacement from Claude:', JSON.stringify(rawOutput?.displacement));
    const safeResult = buildSafeOutput(rawOutput);
    console.log('[CHOIVE] displacement in safeResult:', JSON.stringify(safeResult?.displacement));

    // Stage 3: Save to Supabase
    await saveResult(jobId, safeResult);

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };

  } catch (error) {
    console.error('run-diagnostic-background error:', error?.message);
    if (jobId) {
      try { await saveError(jobId, error.message); } catch (_) {}
    }
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error?.message }) };
  }
};
