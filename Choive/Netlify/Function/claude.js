exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: 'Method Not Allowed'
    };
  }

  try {
    const { name, category, city, website, description } = JSON.parse(event.body || '{}');
    const hasWebsite = website && website.trim().length > 4;

    // ── WEBSITE INSPECTION ──────────────────────────────────────────────────
    let siteData = null;

    if (hasWebsite) {
      try {
        const normalizedUrl = website.startsWith('http') ? website : `https://${website}`;

        const siteRes = await fetch(normalizedUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHOIVEBot/1.0)' },
          signal: AbortSignal.timeout(8000)
        });

        const finalUrl = siteRes.url;
        const html = await siteRes.text();

        const getMatch = (pattern) => {
          const m = html.match(pattern);
          return m ? m[1] : null;
        };

        const title = getMatch(/<title[^>]*>([^<]+)<\/title>/i);
        const metaDesc =
          getMatch(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
          getMatch(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
        const h1 = getMatch(/<h1[^>]*>([^<]+)<\/h1>/i);
        const ogTitle = getMatch(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
        const canonical = getMatch(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);

        const hasJsonLd = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
        const hasFaqSchema = html.includes('"FAQPage"');
        const hasOrgSchema = html.includes('"Organization"');
        const hasLocalBiz = html.includes('"LocalBusiness"');
        const hasOgTags = html.includes('og:title') || html.includes('og:description');

        const visibleText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 800);

        let hasSitemap = false;
        let hasLlmsTxt = false;

        try {
          const base = new URL(finalUrl).origin;
          const [sitemapRes, llmsRes] = await Promise.allSettled([
            fetch(`${base}/sitemap.xml`, { signal: AbortSignal.timeout(4000) }),
            fetch(`${base}/llms.txt`, { signal: AbortSignal.timeout(4000) })
          ]);

          hasSitemap = sitemapRes.status === 'fulfilled' && sitemapRes.value.status === 200;
          hasLlmsTxt = llmsRes.status === 'fulfilled' && llmsRes.value.status === 200;
        } catch (_) {}

        siteData = {
          finalUrl,
          title,
          metaDesc,
          h1,
          ogTitle,
          canonical,
          hasJsonLd,
          hasFaqSchema,
          hasOrgSchema,
          hasLocalBiz,
          hasOgTags,
          hasSitemap,
          hasLlmsTxt,
          visibleText
        };

        siteData.siteScore = { clarity: 0, trust: 0, ease: 0 };

        // CLARITY
        if (siteData.title) siteData.siteScore.clarity += 5;
        if (siteData.metaDesc) siteData.siteScore.clarity += 5;
        if (siteData.h1) siteData.siteScore.clarity += 5;
        if (siteData.visibleText && siteData.visibleText.length > 200) siteData.siteScore.clarity += 10;

        // TRUST
        if (siteData.hasOrgSchema) siteData.siteScore.trust += 5;
        if (siteData.hasLocalBiz) siteData.siteScore.trust += 5;
        if (siteData.canonical) siteData.siteScore.trust += 5;
        if (siteData.hasSitemap) siteData.siteScore.trust += 10;

        // EASE
        if (siteData.hasJsonLd) siteData.siteScore.ease += 10;
        if (siteData.hasFaqSchema) siteData.siteScore.ease += 5;
        if (siteData.hasOgTags) siteData.siteScore.ease += 5;
        if (siteData.hasLlmsTxt) siteData.siteScore.ease += 5;
      } catch (fetchErr) {
        siteData = { error: `Could not fetch website: ${fetchErr.message}` };
      }
    }

    // ── BASE SCORE ───────────────────────────────────────────────────────────
    const baseScore = {
      clarity: siteData?.siteScore?.clarity || 0,
      trust: siteData?.siteScore?.trust || 0,
      ease: siteData?.siteScore?.ease || 0,
      difference: 10
    };

    // ── PROMPT ──────────────────────────────────────────────────────────────
    const siteInspectionBlock = siteData
      ? siteData.error
        ? `Website inspection failed: ${siteData.error}. Use web search to compensate.`
        : `WEBSITE INSPECTION RESULTS (fetched directly — use these for scoring):
Final URL: ${siteData.finalUrl}
Page title: ${siteData.title || 'MISSING'}
Meta description: ${siteData.metaDesc || 'MISSING'}
First H1: ${siteData.h1 || 'MISSING'}
OG title: ${siteData.ogTitle || 'MISSING'}
Canonical tag: ${siteData.canonical || 'MISSING'}
JSON-LD schema present: ${siteData.hasJsonLd}
FAQ schema: ${siteData.hasFaqSchema}
Organization schema: ${siteData.hasOrgSchema}
LocalBusiness schema: ${siteData.hasLocalBiz}
Open Graph tags: ${siteData.hasOgTags}
Sitemap.xml: ${siteData.hasSitemap}
llms.txt: ${siteData.hasLlmsTxt}
Visible text sample: "${siteData.visibleText}"

STRUCTURED WEBSITE SCORE (use this as ground truth):
${JSON.stringify(siteData.siteScore)}

BASE SCORE (must be used as foundation, not overridden):
${JSON.stringify(baseScore)}`
      : `No website provided. Base analysis on web search results and general AI knowledge only.

BASE SCORE (must be used as foundation, not overridden):
${JSON.stringify(baseScore)}`;

    const prompt = `You are the CHOIVE· diagnostic engine. You analyze AI recommendation visibility — whether a business appears when customers ask AI platforms for recommendations.

BUSINESS TO ANALYZE:
- Name: ${name}
- Category: ${category}
- Location: ${city}
- Website: ${website || 'Not provided'}
- Description: ${description || 'Not provided'}

${siteInspectionBlock}

${hasWebsite ? `REQUIRED: Use the web_search tool to search for:
1. "${name} ${city}" — check third-party mentions, reviews, directories
2. "${name}" — check citations, press, backlinks, social presence
3. "best ${category} ${city}" — find the top 3 competitors that AI recommends

Do NOT guess. Score based only on what you find.` : `Use web_search to search for:
1. "${name} ${city}" — check any online presence
2. "best ${category} ${city}" — find top 3 competitors AI recommends`}

SCORING RULES:
- Start from baseScore for each pillar
- Adjust each pillar ONLY +/- 5 points based on web search evidence
- Do NOT create scores from scratch
- Final total must reflect baseScore + adjustments
- If no strong evidence → do NOT increase score

Pillar definitions:
- Clarity (0-25): How precisely can AI define this business? Grounded in title, H1, meta description, schema, messaging consistency.
- Trust (0-25): Credible third-party sources, reviews, directories, backlinks. Web search evidence only.
- Difference (0-25): Can AI explain specifically why someone should choose this business? Clear differentiator from competitors?
- Ease (0-25): JSON-LD schema, FAQ schema, structured content, sitemap, llms.txt. Missing signals reduce score.

STRICT:
- Max adjustment per pillar: +5
- If no evidence: keep base score
- No assumptions
- Do NOT guess competitors — only use web_search results
- If unsure, say weak — not present
- Use structured siteScore as primary evidence

COMPETITOR COMPARISON:
Find exactly 3 real competitors in the same category and city that AI platforms are more likely to recommend. Only use competitors found via web_search — do not invent. For each competitor:
- explain why AI chooses them instead
- compare directly against the submitted business signals
- reference specific differences (reviews, schema, clarity, positioning)

If competitors cannot be verified via web_search, return an empty competitors array.

Respond ONLY with this exact JSON (no markdown, no preamble):
{
  "overallScore": <number 0-100>,
  "verdictHeadline": "<max 8 words>",
  "verdictLevel": "<absent|weak|present>",
  "summaryParagraph": "<2-3 sentences based on actual findings>",
  "pillars": {
    "clarity": { "score": <0-25>, "finding": "<2 sentences citing specific evidence>" },
    "trust": { "score": <0-25>, "finding": "<2 sentences citing specific evidence>" },
    "difference": { "score": <0-25>, "finding": "<2 sentences citing specific evidence>" },
    "ease": { "score": <0-25>, "finding": "<2 sentences citing specific signals found or missing>" }
  },
  "platformCoverage": {
    "chatgpt": { "status": "<absent|weak|present>", "detail": "<one sentence>" },
    "perplexity": { "status": "<absent|weak|present>", "detail": "<one sentence>" },
    "gemini": { "status": "<absent|weak|present>", "detail": "<one sentence>" },
    "claude": { "status": "<absent|weak|present>", "detail": "<one sentence>" }
  },
  "evidenceNarrative": "<3-4 sentences — what was found, what was missing, what AI sees>",
  "competitors": [
    { "name": "<competitor name>", "reasonChosen": "<why AI recommends them instead>" },
    { "name": "<competitor name>", "reasonChosen": "<why AI recommends them instead>" },
    { "name": "<competitor name>", "reasonChosen": "<why AI recommends them instead>" }
  ],
  "selectionGap": {
    "biggestWeakness": "<the single biggest reason AI doesn't recommend this business>",
    "strongestAsset": "<the single strongest signal they already have>",
    "firstPriority": "<the one action that would most improve their score>"
  },
  "actions": [
    { "priority": "critical", "title": "<action>", "body": "<2 sentences>" },
    { "priority": "high", "title": "<action>", "body": "<2 sentences>" },
    { "priority": "high", "title": "<action>", "body": "<2 sentences>" },
    { "priority": "medium", "title": "<action>", "body": "<2 sentences>" }
  ]
}`;

    // ── ANTHROPIC REQUEST ───────────────────────────────────────────────────
const requestBody = {
  model: 'claude-sonnet-4-6',
  max_tokens: 3000,
  messages: [{ role: 'user', content: prompt }],
  tools: [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5
    }
  ],
  tool_choice: hasWebsite
    ? { type: 'tool', name: 'web_search' }
    : { type: 'auto' }
};

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const raw = await anthropicResponse.json();

    // ── PARSE RESPONSE ──────────────────────────────────────────────────────
    let output = raw;

    if (raw.content && Array.isArray(raw.content)) {
      const text = raw.content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('');

      if (text) {
        const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        try {
          output = JSON.parse(clean);
        } catch (e) {
          const m = clean.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              output = JSON.parse(m[0]);
            } catch (_) {
              output = raw;
            }
          } else {
            output = raw;
          }
        }
      }
    }

    // ── HARD SCORE LOCK ─────────────────────────────────────────────────────
    if (output && output.pillars) {
      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }

      output.pillars.clarity.score = clamp(
        output.pillars.clarity?.score || 0,
        baseScore.clarity,
        baseScore.clarity + 5
      );

      output.pillars.trust.score = clamp(
        output.pillars.trust?.score || 0,
        baseScore.trust,
        baseScore.trust + 5
      );

      output.pillars.ease.score = clamp(
        output.pillars.ease?.score || 0,
        baseScore.ease,
        baseScore.ease + 5
      );

      output.pillars.difference.score = clamp(
        output.pillars.difference?.score || 0,
        baseScore.difference - 5,
        baseScore.difference + 5
      );

      const total =
        output.pillars.clarity.score +
        output.pillars.trust.score +
        output.pillars.difference.score +
        output.pillars.ease.score;

      output.overallScore = total;

      if (total <= 30) {
        output.verdictLevel = 'absent';
        output.verdictHeadline = 'AI does not recommend you';
      } else if (total <= 55) {
        output.verdictLevel = 'weak';
        output.verdictHeadline = 'Weak AI recommendation presence';
      } else {
        output.verdictLevel = 'present';
        output.verdictHeadline = 'You are being recommended';
      }
    }

    return {
      statusCode: anthropicResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(output)
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
