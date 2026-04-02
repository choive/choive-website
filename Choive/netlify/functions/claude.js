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

    const prompt = `
You are CHOIVE™ — a decision intelligence engine.

Analyze this business:

Name: ${name || ''}
Category: ${category || ''}
Location: ${city || ''}
Website: ${website || ''}
Description: ${description || ''}

Return ONLY valid JSON in this exact structure:

{
  "overallScore": 0,
  "verdictHeadline": "",
  "verdictLevel": "absent",
  "summaryParagraph": "",
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
    { "priority": "high", "title": "", "body": "" },
    { "priority": "high", "title": "", "body": "" },
    { "priority": "medium", "title": "", "body": "" }
  ]
}

Rules:
- Use scores from 0 to 25 for each pillar
- overallScore must equal clarity + trust + difference + ease
- verdictLevel must be one of: absent, weak, present
- platform status must be one of: absent, weak, present
- Do not return markdown
- Do not return explanation outside JSON
`;

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1200,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    const raw = await anthropicResponse.json();

    let output = raw;

    if (raw.content && Array.isArray(raw.content)) {
      const text = raw.content
        .map(block => block.text || '')
        .join('')
        .trim();

      const clean = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();

      try {
        output = JSON.parse(clean);
      } catch (e) {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) {
          output = JSON.parse(match[0]);
        }
      }
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
      summaryParagraph: output?.summaryParagraph || 'The diagnostic could not fully assess this business.',
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

    const c = Number(safeOutput.pillars.clarity?.score || 0);
    const t = Number(safeOutput.pillars.trust?.score || 0);
    const d = Number(safeOutput.pillars.difference?.score || 0);
    const e = Number(safeOutput.pillars.ease?.score || 0);

    const total = c + t + d + e;
    safeOutput.overallScore = total;

    if (total <= 30) {
      safeOutput.verdictLevel = 'absent';
      safeOutput.verdictHeadline = 'AI does not recommend you';
    } else if (total <= 55) {
      safeOutput.verdictLevel = 'weak';
      safeOutput.verdictHeadline = 'Weak AI recommendation presence';
    } else {
      safeOutput.verdictLevel = 'present';
      safeOutput.verdictHeadline = 'You are being recommended';
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
    return {
      statusCode: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        overallScore: 0,
        verdictHeadline: 'Diagnostic failed',
        verdictLevel: 'absent',
        summaryParagraph: error.message || 'The diagnostic could not be completed.',
        pillars: {
          clarity: { score: 0, finding: 'No result returned.' },
          trust: { score: 0, finding: 'No result returned.' },
          difference: { score: 0, finding: 'No result returned.' },
          ease: { score: 0, finding: 'No result returned.' }
        },
        platformCoverage: {
          chatgpt: { status: 'absent', detail: 'No result returned.' },
          perplexity: { status: 'absent', detail: 'No result returned.' },
          gemini: { status: 'absent', detail: 'No result returned.' },
          claude: { status: 'absent', detail: 'No result returned.' }
        },
        evidenceNarrative: 'The backend returned an error before a structured diagnostic could be completed.',
        actions: [
          {
            priority: 'critical',
            title: 'Check backend configuration',
            body: error.message || 'Verify your backend response structure and API configuration.'
          }
        ]
      })
    };
  }
};
