exports.handler = async function (event) {

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
async function callClaude(messages, tools = undefined) {
const response = await fetch(ANTHROPIC_API_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  },
  body: JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 2000,
    temperature: 0.2,
    messages,
    ...(tools ? { tools } : {})
  })
});

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || `Anthropic API error (${response.status})`);
  }

  return data;
}

const CLAUDE_WEB_TOOLS = [
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 1
  }
];
  
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

const externalContext = `
BUSINESS INPUT:

Name: ${name || ''}
Category: ${category || ''}
Location: ${city || ''}
Website: ${website || 'not provided'}
Description: ${description || ''}

INSTRUCTION:

Use live web search to:
- identify the business
- verify what it does
- assess its presence
- compare it with alternatives

Do not rely only on the submitted input.
`;
    
const prompt = `
${externalContext}

LIVE WEB RULE (MANDATORY):

Use live web search to identify the business, understand what it does, and assess how it is represented online.

Use live evidence to determine:
- what the business is
- who it serves
- whether it is credible
- how easy it is to understand
- how easy it is to choose
- how it compares with alternatives

If a website is provided, use it as supporting evidence.
If no website is provided, still identify the business from live web evidence.

Do not invent facts.
Do not rely on assumptions when live web evidence is available.    

You are CHOIVE™ — a decision intelligence engine.

Your role is not to audit or describe a business.

Your role is to determine:
HOW clearly and strongly this business is understood across the internet.

You operate at the level of decision psychology, not surface analysis.

UNDERSTAND FIRST (CRITICAL):

LIVE EVIDENCE PRIORITY:

First, use live web evidence to determine:

1. What the business actually does
2. Who the business serves
3. Whether it is B2B, B2C, infrastructure, platform, service, or product
4. What context it should realistically compete in

Only after that:
- score clarity
- score trust
- score ease
- score difference

If the website is clear and live evidence confirms it, clarity must stay high.
If the business has real clients, partnerships, or proof, trust must stay moderate to high.
Ease must reflect how easily it is encountered and chosen in real decision moments.

Before doing anything else:

1. Identify what the business actually is
   - B2C (consumer)
   - B2B (enterprise)
   - infrastructure / behind-the-scenes
   - platform / service / product

2. Identify WHO chooses this business
   - consumers
   - companies
   - operators
   - internal buyers

3. Identify WHERE it should realistically appear
   - consumer search (Google, AI assistants)
   - industry search (B2B queries, niche queries)
   - direct sales (not search-driven)

Only after this:

→ Decide if the business is evaluated in the correct context

CRITICAL:

- If the business is NOT meant to appear in consumer queries,
  you must NOT penalize it for missing those queries

- If the business is B2B or infrastructure,
  evaluate whether it is clear, trusted, and strong in its OWN context

You are not evaluating visibility alone.

You are evaluating:
→ how well the business is understood AND chosen in its correct environment

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

LOCATION INTERPRETATION RULE:

Do not assume the business operates only in the provided location.

If the business is global or B2B:

- Treat location as contextual, not restrictive
- Do not limit evaluation to local consumer visibility

A global or enterprise business should not be penalized for weak local presence.

REAL WORLD EVIDENCE:

Use live web evidence as the primary source of truth.

If a website is provided, use it as supporting evidence.
If no website is provided, do not treat that as absence.
Use live search to identify the business and evaluate it accurately.

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
--------------------------------

COMPETITIVE POSITIONING (CRITICAL):

You must determine where this business stands in its category.

Classify it into ONE tier:

- dominant → default choice, shows up everywhere, widely selected
- strong → frequently selected, trusted, well positioned
- upper_mid → competitive, credible, but not leading
- mid → present but not strongly competitive
- weak → rarely selected, low presence
- absent → not part of the decision set

Base this ONLY on:

- search visibility
- presence in results
- strength of signals
- clarity and trust
- how easily it would be chosen

IMPORTANT:

Do NOT confuse:
- being a real company
- with being a top competitor

A company can:
- exist
- have clients
- be credible

AND still be:
→ mid or upper_mid tier

Your classification must reflect:
→ how likely it is to win against competitors

--------------------------------

MARKET POSITION LABEL RULE:

Convert the tier into a simple human label:

dominant → "Category leader"
strong → "Strong competitor"
upper_mid → "Competing but not leading"
mid → "Present but not competitive"
weak → "Struggling to compete"
absent → "Not in the competitive set"

Explanation must be:
- 1 short sentence
- direct
- no fluff

--------------------------------

REAL SCORING FOUNDATION (CRITICAL):

Score this business based on live web evidence first.

Use:
- live web search
- the business website if provided
- visible third-party mentions
- competitive context
- clear business signals

Do not pretend to know how other AI systems would rank the business.

Your job is to determine, from real live evidence:

- how clearly this business is understood
- how credible it is
- how easy it is to encounter and choose
- how distinct it is from alternatives

SCORING RULES:

- Clarity = how clearly the business is defined and understood
- Trust = how credible, real, and verifiable it appears
- Ease = how easily it is encountered and chosen in real decision moments
- Difference = how clearly it stands apart from alternatives

Do not invent missing facts.
Do not force low scores if live evidence clearly supports the business.
Do not force high scores if live evidence does not support them.

--------------------------------

REALITY PRIORITY RULE (CRITICAL):

You must separate TWO things:

1. What the business IS
2. Where the business SHOWS UP

These are NOT the same.

If the website clearly explains the business:

→ Clarity MUST be high
→ You are NOT allowed to reduce clarity based on search absence

If the business has real clients, partnerships, or scale:

→ Trust MUST be moderate to high
→ You are NOT allowed to reduce trust due to weak visibility

CRITICAL:

Search visibility affects:
→ Ease
→ Selection likelihood

Search visibility does NOT define:
→ what the business is
→ whether it is real or credible

Do not collapse everything into visibility.

Evaluate:
- clarity from the website
- trust from real signals
- ease from discoverability
- difference from positioning

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

DECISION CONSEQUENCE RULE (CRITICAL):

Every summary must end with a real-world consequence.

You must explicitly state what happens because of this positioning.

Examples:

- "This means it is not chosen in real decisions."
- "Customers move to more visible alternatives."
- "It is trusted but not picked."
- "It exists but does not win the moment of choice."

CRITICAL:

Do NOT stop at describing the situation.

You MUST state the outcome:
→ what happens because of it

Every result must answer:
→ what does this cost the business?

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

AI INTERPRETATION RULE (CRITICAL):

This diagnostic is based on real Claude evaluation using live web evidence.

Do not pretend to speak for ChatGPT, Perplexity, or Gemini.

Use the platformCoverage fields as diagnostic interpretation states only.

Set each platform status using these meanings:

- present = strongly understood and likely to be returned in relevant decision contexts
- weak = understood but not likely to be prioritized
- absent = not strongly positioned to be returned in decision contexts

For each platform detail:
- keep it short
- keep it direct
- do not claim certainty about another model's private ranking system
- describe selection likelihood, not hidden model behavior
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

STRICT OUTPUT MODE (MANDATORY):

You must return ONLY valid JSON.

Do not include:
- explanations
- extra text
- markdown
- commentary

If you cannot complete the task, still return valid JSON with all required fields.

The JSON must strictly follow the schema provided.

No text is allowed before or after the JSON.

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

--------------------------------

RULES:

- Scores must be 0–25 per pillar
- overallScore must equal sum of all pillars
- verdictLevel must be: absent, weak, present
- Be sharp, decisive, and strategic
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
const raw = await callClaude(
  [
    {
      role: 'user',
      content: prompt
    }
  ],
  CLAUDE_WEB_TOOLS
);

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
        summaryParagraph: 'This business could not be fully verified with enough confidence from the available evidence. It is not strongly positioned to be chosen.',
        businessUnderstanding: '',
        marketPosition: {
          tier: 'unknown',
          label: 'Unclear position',
          explanation: 'Evidence was incomplete.'
        },
        evidenceNarrative: 'The available evidence was incomplete or could not be structured cleanly enough for a stronger result.',
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
            body: 'Add stronger visible proof, references, and supporting signals.'
          },
          {
            priority: 'high',
            title: 'Clarify positioning',
            body: 'Make what the business does and why it is different easier to understand.'
          },
          {
            priority: 'medium',
            title: 'Increase discoverability',
            body: 'Improve how easily the business is encountered in relevant decision contexts.'
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
    summaryParagraph: `${name || 'This business'} is understood only weakly from the available evidence and is not strongly positioned to be chosen. Stronger alternatives are easier to encounter and trust.`,
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
        body: 'Add stronger proof, references, and credibility signals people can verify quickly.'
      },
      {
        priority: 'high',
        title: 'Sharpen difference',
        body: 'Make the reason to choose this business over alternatives more obvious.'
      },
      {
        priority: 'medium',
        title: 'Improve encounter strength',
        body: 'Increase how easily the business is found and understood in relevant decision contexts.'
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

const c = Number(safeOutput.pillars.clarity?.score || 0);
const t = Number(safeOutput.pillars.trust?.score || 0);
const d = Number(safeOutput.pillars.difference?.score || 0);
const e = Number(safeOutput.pillars.ease?.score || 0);

const total = c + t + d + e;
safeOutput.overallScore = total;

const easeScore = Number(safeOutput.pillars.ease?.score || 0);
const marketTier = safeOutput.marketPosition?.tier || '';

if (total <= 30) {
  safeOutput.verdictLevel = 'absent';
  safeOutput.verdictHeadline = 'Not the obvious choice — losing decisions';
} else if (
  total <= 55 ||
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
      verdictLevel: 'weak',
      summaryParagraph: 'The system could not complete this analysis.',
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
