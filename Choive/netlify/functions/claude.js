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
const queries = [
  `best ${category} in ${city}`,
  `top ${category} companies`,
  `${category} providers`,
  `${category} services`,
  `${name}`
];
    const allResults = await Promise.all(
  queries.map(q =>
    fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q, num: 5 })
    }).then(res => res.json())
  )
);

const organicResults = allResults.flatMap(r => r.organic || []);    
const visibilityScore = organicResults.findIndex(result =>
  result.link?.includes(website)
);
    const visibilityContext = `
VISIBILITY DATA:

- Appears in search results: ${visibilityIndex !== -1 ? 'YES' : 'NO'}
- Position: ${visibilityIndex !== -1 ? visibilityIndex + 1 : 'Not in top results'}

Top results shown instead:
${organicResults.map(r => `- ${r.title}`).join('\n')}
`;
    let websiteContent = '';

if (website) {
  try {
    const siteRes = await fetch(website);
    const html = await siteRes.text();

    // VERY SIMPLE TEXT EXTRACTION
    websiteContent = html
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000); // limit size
  } catch (e) {
    websiteContent = '';
  }
}
    const prompt = `
    ${visibilityContext}
WEBSITE CONTENT (IF AVAILABLE):
${websiteContent}

You are CHOIVE™ — a decision intelligence engine.

Your role is not to audit or describe a business.

Your role is to determine:
WHY this business is or is not the obvious choice.

You operate at the level of decision psychology, not surface analysis.

TONE RULE:

- Do NOT soften conclusions
- Do NOT use “may”, “might”, “could”
- Speak in definitive terms based on visibility data
- The output should feel like a system, not a consultant

--------------------------------

Analyze this business:

Name: ${name || ''}
Category: ${category || ''}
Location: ${city || ''}
Website: ${website || ''}
Description: ${description || ''}

REAL WORLD DATA:

Search results:
${JSON.stringify(searchData)}

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

CLARITY SCORING RULE:

- High clarity = clearly states what it is and who it serves
- Medium clarity = understandable but generic
- Low clarity = ambiguous, vague, or undefined

IMPORTANT:
Do NOT assign low clarity if the website clearly explains the business.

2. Trust  
→ Does it feel real, credible, and verifiable?

3. Difference  
→ Is it meaningfully distinct, or interchangeable?

4. Ease  
→ Is it simple and frictionless to choose?

--------------------------------

AI SELECTION SIMULATION (CRITICAL):

REAL DATA USAGE (MANDATORY):

You must use the provided search results before scoring.

Do NOT assume absence if search data exists.
Do NOT ignore external mentions, directories, reviews, or public profiles found in search results.

Base your judgment on:
- the website
- the provided search results
- external evidence found in those results

If the business appears in search results but is not strongly recommended, describe it as:
- present but weak
- known but not selected
- visible but not favored

Do NOT invent facts beyond the supplied evidence.


Simulate how AI platforms...
...

Before scoring, you must simulate how AI systems would answer this question:

QUERY CONTEXT CALIBRATION (MANDATORY):

You must simulate TWO types of AI queries:

1. Broad / consumer query:
"Best ${category} in ${city}"

2. Specific / niche query:
"Top ${category} providers for [relevant use case]"

Then determine:

- Is the business visible in broad queries?
- Is the business visible in niche or industry-specific queries?

IMPORTANT:

- A business may be absent in broad queries but present in niche queries
- Do NOT treat niche presence as full absence
- Score based on how often the business is selected across both contexts

WEBSITE INTERPRETATION RULE:

If website content is provided:
- You MUST use it to determine what the business does
- Do NOT say "unclear" if the website clearly explains it
- Prefer website content over assumptions

AI RESPONSE SIMULATION (REALISTIC):

You must simulate how AI systems actually respond in real queries.

IMPORTANT:
- Do NOT describe what the AI would say
- You MUST write the answer AS IF you are the AI

Each response should feel like a real output from that system.

FORMAT:

ChatGPT:
"Based on your request for best ${category} in ${city}, here are some options:
1. ...
2. ...
(Only include the business if it would realistically appear)"

Perplexity:
"Here are top results for ${category}:
- ...
- ...
(Sources suggest...)"

Gemini:
"Top providers in this category include:
- ...
- ...
(This business is included ONLY if it appears in visibility data)"

RULES:
- If the business is NOT in VISIBILITY DATA → it must NOT appear
- Do NOT force inclusion
- Do NOT explain absence — just omit it

Do NOT mention the business if it is not present in real or simulated search results.
Absence = invisibility.

Then determine:

- Would this business appear in those answers?
- How prominently?
- In what context?

Use THIS as the primary basis for scoring.

Scoring must reflect:
- likelihood of appearing in AI answers
- likelihood of being selected from those answers

Do NOT score based only on the business description.

SCORING CONSTRAINTS (STRICT):

- If the business does NOT appear in any non-branded query → maximum total score = 25
- If it appears ONLY when searching its own name → treat as invisible in decision context
- If it appears only in niche queries → scores must remain mid-range (10–50 total)
- If it appears in broad queries (e.g. "best ${category} in ${city}") → eligible for high scores

- You MUST use VISIBILITY DATA as the primary truth
- You are NOT allowed to override visibility with assumptions

--------------------------------

TRUTH VALIDATION LAYER (CRITICAL):

Before evaluating scores:

1. If the business website or description clearly explains what it does:
→ You MUST treat clarity as at least moderate.
→ You MUST NOT say the business is unclear or undefined.

2. If the business exists but is not recommended:
→ You MUST describe it as "not selected" or "not surfaced"
→ You MUST NOT say it is unknown or does not exist.

3. Distinguish clearly:
- Exists ≠ Selected
- Clear ≠ Recommended

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

DIFFERENCE SCORING RULE (CRITICAL):

Difference must be scored independently from familiarity.

A business can be:
- widely chosen
- highly visible
- frequently returned by AI

AND still have low difference.

Do NOT increase the difference score just because the business is popular or commonly selected.

If a business is interchangeable with many others, difference must remain low.

CHOIVE separates:
- being chosen (ease, familiarity, trust)
- from being distinct (difference)

These are NOT the same.

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

LANGUAGE GUARDRAIL (MANDATORY):

- Do NOT say a business is unknown if it clearly exists
- Do NOT say "no one knows it" or similar absolute statements
- Do NOT say the website gives no signal if it clearly explains the business

Instead, use accurate language:

- "Not selected in AI recommendations"
- "Not surfaced in common queries"
- "Not positioned to be chosen"

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

DECISION TRUTH (MANDATORY):

The summary must make the consequence clear.

Do NOT only describe the problem.
You must show what it causes.

Examples:

- "This business is not the obvious choice, so it is being skipped in real decisions."
- "This business is not selected, so customers are choosing alternatives instead."
- "This business is clear, but not positioned to be chosen, so it loses opportunities."

Every summary must include:
→ what is happening
→ what it leads to

--------------------------------

PLATFORM COVERAGE RULE:

For each platform (ChatGPT, Perplexity, Gemini, Claude):

- The statement must reflect reality (present, weak, or absent)
- The tone must be decisive, not explanatory
- Use short, direct sentences
- No long reasoning
- No soft language

If PRESENT:
"ChatGPT returns this business early. Familiarity wins."

If WEAK:
"Perplexity includes it but does not favor it. Stronger options exist."

If ABSENT:
"Gemini does not surface this business. It lacks strong signals."

Each platform must:
- sound like a verdict
- be short
- be different

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

CRITICAL:
- Do NOT include any text before or after JSON
- Do NOT explain anything
- Do NOT add comments
- Do NOT use markdown
- Do NOT break JSON format

If you cannot follow this, return a minimal valid JSON with all required fields.

--------------------------------

JSON SAFETY RULE:

All strings must:
- use double quotes only
- not contain line breaks
- not contain unescaped characters

If needed, shorten sentences to keep JSON valid.

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
- Maximum 6–8 words
- No explanation
- No second sentence
- No connectors like “and”, “because”

Write like this:

Clarity: "Instantly understood."
Trust: "Widely trusted and predictable."
Difference: "Not distinct from alternatives."
Ease: "Easy to choose everywhere."

Every pillar must feel:
- fast
- obvious
- human

SUMMARY RULE:

- Maximum 2–3 sentences
- No explanation tone
- No storytelling
- No filler words

Write like a verdict:

"This business is the obvious choice because it removes decision friction. It is familiar, everywhere, and requires no thinking."

Each sentence must feel like a conclusion, not an explanation.

Each summary must end with a consequence:
"People will choose something else instead."

Short. Sharp. Final.

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
      safeOutput.verdictHeadline = 'Not the obvious choice — losing decisions';
    } else if (total <= 55) {
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
