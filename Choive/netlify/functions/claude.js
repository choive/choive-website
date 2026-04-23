exports.handler = async function (event) {
  const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
  const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

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

  async function callClaude(messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

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
          max_tokens: 700,
          temperature: 0.2,
          messages
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error?.message || `Anthropic API error (${response.status})`);
      }

      return data;
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    }
  }

  async function searchWithSerper(name, category, city) {
    if (!process.env.SERPER_API_KEY) {
      throw new Error('Missing SERPER_API_KEY');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const query = [name, category, city].filter(Boolean).join(' ').trim();

    try {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: query,
          num: 5
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Serper error (${response.status}): ${text}`);
      }

      const data = await response.json();

      return {
        organic: Array.isArray(data?.organic) ? data.organic.slice(0, 4) : [],
        knowledgeGraph: data?.knowledgeGraph || null
      };
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new Error('Serper request timed out');
      }
      throw error;
    }
  }

  async function fetchWebsiteText(url) {
    if (!url) return '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0'
        },
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
        .slice(0, 1800);
    } catch (_) {
      clearTimeout(timeout);
      return '';
    }
  }

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

    if (!name || !category || !city) {
      return {
        statusCode: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Missing required fields: name, category, city'
        })
      };
    }

    const serperData = await searchWithSerper(name, category, city);
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

    const websiteText = await fetchWebsiteText(inferredOfficialSite);

    const searchEvidence = organicResults.map((r, i) => {
      return `${i + 1}. ${(r.title || '').slice(0, 90)} — ${(r.snippet || '').slice(0, 140)}`;
    }).join('\n');

    const knowledgeGraphEvidence = serperData.knowledgeGraph
      ? `Title: ${serperData.knowledgeGraph.title || ''}; Type: ${serperData.knowledgeGraph.type || ''}; Website: ${serperData.knowledgeGraph.website || ''}`
      : 'None';

    const visibilityPosition = targetDomain
      ? organicResults.findIndex(r => normalizeUrl(r?.link || '') === targetDomain)
      : -1;

    const externalContext = `
BUSINESS INPUT:
Name: ${name || ''}
Category: ${category || ''}
Location: ${city || ''}
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

Score 4 pillars:
1. Clarity
2. Trust
3. Difference
4. Ease

Scoring:
- Clarity = how clearly the business is defined and understood
- Trust = how credible and verifiable it appears
- Difference = how clearly it stands apart from alternatives
- Ease = how likely it is to be included and chosen in a real decision moment

If website content clearly explains the business, clarity must stay high.
If evidence shows real clients, partnerships, coverage, or scale, trust must stay moderate to high.
Do not collapse everything into visibility alone.

Competitive positioning tier:
- dominant
- strong
- upper_mid
- mid
- weak
- absent

Label mapping:
- dominant = Category leader
- strong = Strong competitor
- upper_mid = Competing but not leading
- mid = Present but not competitive
- weak = Struggling to compete
- absent = Not in the competitive set

Return one short signature line:
- 3 to 6 words
- final
- decision-state based

Decision state must be one of:
- not_seen
- seen_not_considered
- considered_not_chosen
- trusted_not_chosen
- chosen_by_default

summaryParagraph:
- exactly 3 sentences
- sentence 1 must start: "This business is not the obvious choice because..."
- sentence 2 states the reason simply
- sentence 3 states the consequence

Each pillar finding:
- one short sentence
- 3 to 6 words
- no commas
- no explanation

Return ONLY valid JSON:

{
  "overallScore": 0,
  "verdictHeadline": "",
  "verdictLevel": "absent",
  "signatureLine": "",
  "decisionState": "",
  "summaryParagraph": "",
  "businessUnderstanding": "",
  "marketPosition": {
    "tier": "",
    "label": "",
    "explanation": ""
  },
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
}
`;

    const raw = await callClaude([
      {
        role: 'user',
        content: prompt
      }
    ]);

    let output = raw;

    if (raw.content && Array.isArray(raw.content)) {
      const text = raw.content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('')
        .trim();

      const clean = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();

      try {
        output = JSON.parse(clean);
      } catch (e) {
        try {
          const match = clean.match(/\{[\s\S]*\}/);
          if (match) {
            output = JSON.parse(match[0]);
          } else {
            throw e;
          }
        } catch (_) {
          output = {
            overallScore: 20,
            verdictHeadline: 'Not strongly positioned to be chosen',
            verdictLevel: 'weak',
            signatureLine: 'Present — but not chosen.',
            decisionState: 'considered_not_chosen',
            summaryParagraph: 'This business is not the obvious choice because the available evidence is too weak to support stronger selection. It is not understood strongly enough to be favored. Buyers choose clearer alternatives instead.',
            businessUnderstanding: '',
            marketPosition: {
              tier: 'unknown',
              label: 'Unclear position',
              explanation: 'Evidence was incomplete.'
            },
            evidenceNarrative: 'The available evidence was incomplete or could not be structured clearly enough for a stronger result.',
            pillars: {
              clarity: { score: 6, finding: 'Not verified clearly enough.' },
              trust: { score: 5, finding: 'Trust signals are incomplete.' },
              difference: { score: 4, finding: 'Difference is not clear.' },
              ease: { score: 5, finding: 'Not easy to encounter.' }
            },
            platformCoverage: {
              chatgpt: { status: 'weak', detail: 'Understood weakly, not favored.' },
              perplexity: { status: 'weak', detail: 'Positioning is not strong.' },
              gemini: { status: 'weak', detail: 'Not strongly positioned.' },
              claude: { status: 'weak', detail: 'Evidence is incomplete.' }
            },
            actions: [
              {
                priority: 'critical',
                title: 'Strengthen business definition',
                body: 'Make the business easier to identify and verify from available evidence.'
              },
              {
                priority: 'high',
                title: 'Improve trust signals',
                body: 'Add stronger visible proof and supporting signals.'
              },
              {
                priority: 'high',
                title: 'Clarify positioning',
                body: 'Make what the business does and why it is different easier to understand.'
              },
              {
                priority: 'medium',
                title: 'Increase discoverability',
                body: 'Improve how easily the business is understood and encountered.'
              }
            ]
          };
        }
      }
    }

    const hasValidShape =
      output &&
      typeof output === 'object' &&
      output.pillars &&
      output.platformCoverage &&
      output.pillars.clarity &&
      output.pillars.trust &&
      output.pillars.difference &&
      output.pillars.ease &&
      output.platformCoverage.chatgpt &&
      output.platformCoverage.perplexity &&
      output.platformCoverage.gemini &&
      output.platformCoverage.claude;

    if (!hasValidShape) {
      output = {
        overallScore: 24,
        verdictHeadline: 'Not strongly positioned to be chosen',
        verdictLevel: 'weak',
        signatureLine: 'Understood — but not favored.',
        decisionState: 'seen_not_considered',
        summaryParagraph: 'This business is not the obvious choice because the available evidence does not make it strong enough to be favored. It is understood only weakly compared with stronger alternatives. Buyers choose clearer and more trusted options instead.',
        businessUnderstanding: '',
        marketPosition: {
          tier: 'unknown',
          label: 'Unclear position',
          explanation: 'The evidence does not support a stronger competitive conclusion.'
        },
        evidenceNarrative: 'The business does not yet show enough clear, credible, and easy-to-verify signals to support a stronger result.',
        pillars: {
          clarity: { score: 8, finding: 'Not defined clearly enough.' },
          trust: { score: 6, finding: 'Trust signals are limited.' },
          difference: { score: 5, finding: 'Difference is not clear.' },
          ease: { score: 5, finding: 'Hard to encounter quickly.' }
        },
        platformCoverage: {
          chatgpt: { status: 'weak', detail: 'Understood, but not favored.' },
          perplexity: { status: 'weak', detail: 'Not strongly positioned.' },
          gemini: { status: 'weak', detail: 'Positioning is limited.' },
          claude: { status: 'weak', detail: 'Evidence supports only a weak position.' }
        },
        actions: [
          {
            priority: 'critical',
            title: 'Clarify the business fast',
            body: 'Make what the business is and who it serves easier to understand immediately.'
          },
          {
            priority: 'high',
            title: 'Strengthen visible trust',
            body: 'Add stronger proof and credibility signals people can verify quickly.'
          },
          {
            priority: 'high',
            title: 'Sharpen difference',
            body: 'Make the reason to choose this business over alternatives more obvious.'
          },
          {
            priority: 'medium',
            title: 'Improve encounter strength',
            body: 'Increase how easily the business is found and understood in decision contexts.'
          }
        ]
      };
    }

    const fallbackPillar = {
      score: 0,
      finding: 'Insufficient data to assess this pillar.'
    };

    const fallbackPlatform = {
      status: 'absent',
      detail: 'No data available.'
    };

    const safeOutput = {
      overallScore: typeof output?.overallScore === 'number' ? output.overallScore : 0,
      verdictHeadline: output?.verdictHeadline || 'Diagnostic incomplete',
      verdictLevel: output?.verdictLevel || 'absent',
      signatureLine: output?.signatureLine || 'Present — but not chosen.',
      decisionState: output?.decisionState || 'considered_not_chosen',
      summaryParagraph: output?.summaryParagraph || 'The diagnostic could not fully assess this business.',
      businessUnderstanding: output?.businessUnderstanding || '',
      marketPosition: output?.marketPosition || {
        tier: 'unknown',
        label: 'Unknown position',
        explanation: 'Not enough data to determine position.'
      },
      evidenceNarrative: output?.evidenceNarrative || 'No evidence narrative available.',
      pillars: {
        clarity: output?.pillars?.clarity || { ...fallbackPillar },
        trust: output?.pillars?.trust || { ...fallbackPillar },
        difference: output?.pillars?.difference || { ...fallbackPillar },
        ease: output?.pillars?.ease || { ...fallbackPillar }
      },
      platformCoverage: {
        chatgpt: output?.platformCoverage?.chatgpt || { ...fallbackPlatform },
        perplexity: output?.platformCoverage?.perplexity || { ...fallbackPlatform },
        gemini: output?.platformCoverage?.gemini || { ...fallbackPlatform },
        claude: output?.platformCoverage?.claude || { ...fallbackPlatform }
      },
      actions: Array.isArray(output?.actions) && output.actions.length > 0
        ? output.actions
        : [
            {
              priority: 'critical',
              title: 'Retry diagnostic',
              body: 'The engine did not return a complete structured response. Retry the diagnostic after checking the backend response.'
            }
          ]
    };

    const c = clampScore(safeOutput.pillars.clarity?.score);
    const t = clampScore(safeOutput.pillars.trust?.score);
    const d = clampScore(safeOutput.pillars.difference?.score);
    const e = clampScore(safeOutput.pillars.ease?.score);

    safeOutput.pillars.clarity.score = c;
    safeOutput.pillars.trust.score = t;
    safeOutput.pillars.difference.score = d;
    safeOutput.pillars.ease.score = e;

    safeOutput.overallScore = c + t + d + e;

    const easeScore = Number(safeOutput.pillars.ease?.score || 0);
    const marketTier = safeOutput.marketPosition?.tier || '';

    if (safeOutput.overallScore <= 30) {
      safeOutput.verdictLevel = 'absent';
      safeOutput.verdictHeadline = 'Not the obvious choice — losing decisions';
    } else if (
      safeOutput.overallScore <= 55 ||
      easeScore < 12 ||
      ['upper_mid', 'mid', 'weak', 'absent', 'unknown'].includes(marketTier)
    ) {
      safeOutput.verdictLevel = 'weak';
      safeOutput.verdictHeadline = 'Not consistently the obvious choice — losing opportunities';
    } else {
      safeOutput.verdictLevel = 'present';
      safeOutput.verdictHeadline = 'The obvious choice — winning decisions';
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(safeOutput)
    };
  } catch (error) {
    console.error('CHOIVE FUNCTION ERROR:', error?.message || error, error?.stack || '');

    return {
      statusCode: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        overallScore: 0,
        verdictHeadline: 'Diagnostic failed',
        verdictLevel: 'weak',
        signatureLine: 'Present — but not chosen.',
        decisionState: 'considered_not_chosen',
        summaryParagraph: error?.message || 'The system could not complete this analysis.',
        error: error?.message || 'Unknown backend error',
        businessUnderstanding: '',
        marketPosition: {
          tier: 'unknown',
          label: 'Unknown position',
          explanation: 'System error during evaluation.'
        },
        evidenceNarrative: 'The diagnostic failed due to a backend error.',
        pillars: {
          clarity: { score: 0, finding: 'No result returned.' },
          trust: { score: 0, finding: 'No result returned.' },
          difference: { score: 0, finding: 'No result returned.' },
          ease: { score: 0, finding: 'No result returned.' }
        },
        platformCoverage: {
          chatgpt: { status: 'weak', detail: 'No result returned.' },
          perplexity: { status: 'weak', detail: 'No result returned.' },
          gemini: { status: 'weak', detail: 'No result returned.' },
          claude: { status: 'weak', detail: 'No result returned.' }
        },
        actions: [
          {
            priority: 'critical',
            title: 'Retry diagnostic',
            body: 'System error occurred. Try again.'
          }
        ]
      })
    };
  }
};
