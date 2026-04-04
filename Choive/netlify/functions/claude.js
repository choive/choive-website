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

Your role is not to audit or describe a business.

Your role is to determine:
WHY this business is or is not the obvious choice.

You operate at the level of decision psychology, not surface analysis.

--------------------------------

Analyze this business:

Name: ${name || ''}
Category: ${category || ''}
Location: ${city || ''}
Website: ${website || ''}
Description: ${description || ''}

--------------------------------

CHOIVE PRINCIPLE:

Businesses do not become the obvious choice because they are the best.
They become the obvious choice when they create the least doubt.

Your task is to identify where doubt is created.

--------------------------------

EVALUATION FRAME:

You must evaluate across 4 pillars:

1. Clarity  
→ Is the business immediately understood without effort?

2. Trust  
→ Does it feel real, credible, and verifiable?

3. Difference  
→ Is it meaningfully distinct, or interchangeable?

4. Ease  
→ Is it simple and frictionless to choose?

--------------------------------

AI SELECTION SIMULATION (CRITICAL):

Before scoring, you must simulate how AI systems would answer this question:

"Best ${category || 'business'} in ${city || 'this location'}"

Generate a short representation of how:
- ChatGPT
- Perplexity
- Gemini

would respond.

Then determine:

- Would this business appear in those answers?
- How prominently?
- In what context?

Use THIS as the primary basis for scoring.

Scoring must reflect:
- likelihood of appearing in AI answers
- likelihood of being selected from those answers

Do NOT score based only on the business description.

--------------------------------

IMPORTANT SELECTION LOGIC:

A business can still be the obvious choice even if it is not the best option.

If a business is frequently chosen because it is familiar, widely available, trusted, or requires no thinking, this must increase its score significantly.

Ease and familiarity should be weighted heavily in determining if something is the obvious choice.

Do not penalize a business simply for lacking uniqueness if it is still commonly selected in real-world behavior.

Distinguish clearly between:
- "Best choice" (highest quality or experience)
- "Obvious choice" (most likely to be chosen quickly and easily)

CHOIVE measures the obvious choice, not the best choice.

--------------------------------

CRITICAL INSTRUCTIONS:

You are NOT allowed to:
- describe the business neutrally
- explain passively
- use soft language

Avoid:
- “appears”
- “suggests”
- “may”
- “seems”
- “presents itself as”

Instead:
- assert conclusions
- compress reasoning
- remove hesitation

--------------------------------

LANGUAGE RULE (CRITICAL):

Every sentence must sound like how a normal person speaks.

Replace complex or strategic words with simple everyday words.

Examples:
- “friction” → “difficulty”
- “ubiquity” → “everywhere”
- “visibility” → “shows up”
- “prominence” → “shows first”
- “differentiation” → “what makes it different”

If a sentence sounds like a consultant wrote it, rewrite it.

The output must feel like:
→ “I understand this instantly”

NOT:
→ “This sounds intelligent”

--------------------------------

OUTPUT STYLE:

Your output must feel:
- decisive
- strategic
- unavoidable

Not like:
→ a report  
Not like:
→ an analysis  

But like:
→ a clear judgment

--------------------------------

SUMMARY RULE (VERY IMPORTANT):

The summaryParagraph MUST:

- start with the core decision failure
- NOT start with context
- NOT describe the business first

Example structure:

“This business is not the obvious choice because…”

Then explain WHY.

--------------------------------

PLATFORM COVERAGE RULE:

For each platform (ChatGPT, Perplexity, Gemini, Claude):

- Do NOT output generic labels
- Each platform must explain WHY the business is not surfaced
- Each must use DIFFERENT reasoning
- Tie reasoning to:
  → visibility
  → structure
  → trust signals
  → data availability

--------------------------------

ACTIONS RULE:

Actions must:
- be direct
- be strategic
- remove decision friction

Avoid generic advice.

Each action must fix a specific failure.

--------------------------------

OUTPUT FORMAT:

Return ONLY valid JSON.

Do not include any text before or after JSON.
Do not use code fences.

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
    { "priority": "critical", "title": "", "body": "" },
    { "priority": "high", "title": "", "body": "" },
    { "priority": "medium", "title": "", "body": "" }
  ]
}

--------------------------------

RULES:

- Scores must be 0–25 per pillar
- overallScore must equal sum of all pillars
- verdictLevel must be: absent, weak, present
- Be sharp, decisive, and strategic
- Focus on WHY the business is NOT the obvious choice
- Eliminate all generic phrasing
- Use short, direct sentences
- No technical language
- No abstract words
- Write like a final verdict, not an explanation
- Every sentence must be instantly understood on first read

PILLAR LANGUAGE RULES (MANDATORY):
- Each pillar finding must be ONE short sentence
- Do NOT explain
- Do NOT justify
- Do NOT add extra detail

Use EXACT phrasing:

Clarity: "This business is not clear enough."
Trust: "This business is not trusted enough."
Difference: "This business is not strong enough compared to others."
Ease: "This business is not simple enough to choose."

SUMMARY RULE:
- The summary must be one short paragraph
- No technical words
- No mention of AI, model, system, signals, or data

Write like this:
"This business is not the obvious choice because it is not clear enough, not trusted enough, and not strong enough compared to other options."

`;
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
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
    if (!anthropicResponse.ok) {
  console.error('ANTHROPIC STATUS:', anthropicResponse.status);
  console.error('ANTHROPIC RAW:', JSON.stringify(raw));

  throw new Error(
    raw?.error?.message || `Anthropic API error (${anthropicResponse.status})`
  );
}

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
        overallScore: 12,
        verdictHeadline: 'AI does not recommend you',
        verdictLevel: 'absent',
        evidenceNarrative: 'The available signals are incomplete, unclear, or inconsistent, preventing a confident recommendation across AI systems.',
        pillars: {
          clarity: { score: 3, finding: 'The business is not immediately understood.' },
          trust: { score: 2, finding: 'Credibility is weakened by incomplete or broken signals.' },
          difference: { score: 4, finding: 'The offer is not clearly distinct from alternatives.' },
          ease: { score: 3, finding: 'Decision friction is too high for confident selection.' }
        },
        platformCoverage: {
          chatgpt: { status: 'absent', detail: 'Insufficient structured confidence for recommendation.' },
          perplexity: { status: 'absent', detail: 'Weak searchable and verifiable signal density.' },
          gemini: { status: 'absent', detail: 'Not enough clear business definition for surfacing.' },
          claude: { status: 'absent', detail: 'Decision confidence is blocked by missing clarity and trust.' }
        },
        actions: [
          {
            priority: 'critical',
            title: 'Remove decision ambiguity',
            body: 'Clarify exactly what the business is and why it should be the obvious choice.'
          },
          {
            priority: 'critical',
            title: 'Repair trust signals',
            body: 'Fix broken or unverifiable infrastructure and establish legitimate web presence.'
          },
          {
            priority: 'high',
            title: 'Define differentiation',
            body: 'State what makes the business meaningfully different from alternatives.'
          },
          {
            priority: 'medium',
            title: 'Improve AI readability',
            body: 'Make the business easier to understand, verify, and select.'
          }
        ]
      };
    }
  }
}

// 👇 ADD THIS RIGHT HERE 👇
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
    verdictHeadline: 'Not consistently the obvious choice',
    verdictLevel: 'weak',
    summaryParagraph: `${name || 'This business'} is not the obvious choice because it is not clear enough, not trusted enough, and not strong enough compared to other options. People will choose something else instead.`,
    pillars: {
      clarity: { score: 8, finding: 'This business is not clear enough.' },
      trust: { score: 5, finding: 'This business is not trusted enough.' },
      difference: { score: 6, finding: 'This business is not strong enough compared to others.' },
      ease: { score: 5, finding: 'This business is not simple enough to choose.' }
    },
    platformCoverage: {
      chatgpt: { status: 'weak', detail: 'Not strongly recommended.' },
      perplexity: { status: 'weak', detail: 'Not strongly recommended.' },
      gemini: { status: 'weak', detail: 'Not strongly recommended.' },
      claude: { status: 'weak', detail: 'Not strongly recommended.' }
    },
    evidenceNarrative: 'The business does not present enough clear, reliable, or strong information for people to confidently choose it.',
    actions: [
      {
        priority: 'critical',
        title: 'Clarify what this business is',
        body: 'Make it instantly clear what the business offers and why someone should choose it.'
      },
      {
        priority: 'high',
        title: 'Strengthen trust',
        body: 'Add clear signs that the business is real, reliable, and easy to verify.'
      },
      {
        priority: 'high',
        title: 'Show why it is different',
        body: 'Make the reason to choose this business over others obvious.'
      },
      {
        priority: 'medium',
        title: 'Make it easier to choose',
        body: 'Reduce confusion and make the business simpler to understand and act on.'
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
      safeOutput.verdictHeadline = 'Not the obvious choice';
    } else if (total <= 55) {
      safeOutput.verdictLevel = 'weak';
      safeOutput.verdictHeadline = 'Not consistently the obvious choice';
    } else {
      safeOutput.verdictLevel = 'present';
      safeOutput.verdictHeadline = 'The obvious choice';
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
  console.error('CHOIVE FUNCTION ERROR:', error);
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
        summaryParagraph: 'This diagnostic could not be completed. Please try again.',
        pillars: {
          clarity: { score: 3, finding: 'This business is not clear enough.' },
          trust: { score: 2, finding: 'This business is not trusted enough.' },
          difference: { score: 4, finding: 'This business is not strong enough compared to others.' },
          ease: { score: 3, finding: 'This business is not simple enough to choose.' }
        },
        platformCoverage: {
          chatgpt: { status: 'absent', detail: 'No result returned.' },
          perplexity: { status: 'absent', detail: 'No result returned.' },
          gemini: { status: 'absent', detail: 'No result returned.' },
          claude: { status: 'absent', detail: 'No result returned.' }
        },
        evidenceNarrative: 'The diagnostic could not be completed this time.',
          actions: [
        {
          priority: 'critical',
          title: 'Try the diagnostic again',
          body: 'The diagnostic could not be completed this time. Please try again in a moment.'
        }
      ]
      })
    };
  }
};
