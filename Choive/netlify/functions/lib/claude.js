// lib/claude.js
// Sends evidence to Anthropic Claude and returns parsed CHOIVE result
// ENV: ANTHROPIC_API_KEY

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS = 55000;
const MAX_TOKENS = 2500;

async function scoreWithClaude(evidence) {
  const prompt = buildPrompt(evidence);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error?.message || `Anthropic HTTP ${response.status}`);
    }

    return parseClaudeResponse(data);
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') throw new Error('Claude request timed out');
    throw error;
  }
}

function parseClaudeResponse(data) {
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Claude returned empty response');

  // Strip markdown fences if present
  const clean = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Attempt 1: direct parse
  try {
    return JSON.parse(clean);
  } catch (_) {}

  // Attempt 2: extract first {...} block
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (_) {}
  }

  // Log and throw
  console.error('Claude raw response (parse failed):', text.slice(0, 500));
  throw new Error('Could not parse Claude response as JSON');
}

function buildPrompt(evidence) {
  const {
    name, category, city, website, description,
    inferredOfficialSite, websiteText,
    searchText, kgText, visibilityPosition
  } = evidence;

  return `BUSINESS INPUT:
Name: ${name}
Category: ${category}
Location: ${city}
Website: ${website || 'not provided'}
Description: ${description || 'not provided'}
INFERRED OFFICIAL WEBSITE:
${inferredOfficialSite || 'not found'}
KNOWLEDGE GRAPH:
${kgText || 'None'}
SEARCH RESULTS:
${searchText || 'No search results returned.'}
WEBSITE CONTENT:
${websiteText || 'No website content available.'}
VISIBILITY:
Website appears in search results: ${visibilityPosition !== -1 ? `YES (position ${visibilityPosition + 1})` : 'NO'}
---
You are CHOIVE™ — a decision intelligence engine.
Your role is to judge how strongly this business is positioned to be chosen.
Use the evidence provided. Be precise. Be strict. Do not guess.
FIRST — determine business context:
1. What is this business exactly
2. Who selects it and in what context
3. Is it B2B, B2C, infrastructure, platform, service, or product
4. Where should it realistically compete — local, national, or global
If B2B or infrastructure: do not penalise for low consumer visibility.
If local business: weight local signals heavily.
If global/platform: weight citation breadth and schema completeness.
CHOIVE PRINCIPLE:
Businesses are not chosen because they are the best.
They are chosen because they create the least doubt.
SCORING — four pillars, each 0–25:
CLARITY (0–25)
What is actually being scored: how precisely and consistently this business is defined across every surface AI reads.
Score high when: website has a clear, specific H1; meta description names the category and differentiator; schema defines entity type; consistent description across all visible sources.
Score low when: vague homepage copy; no entity definition; inconsistent naming; AI cannot tell exactly what this business does or for whom.
TRUST (0–25)
What is actually being scored: the volume and quality of third-party signals that confirm this business is real, credible, and established.
Score high when: appears in independent publications, directories, and review platforms; knowledge graph exists; citations from credible sources; visible client or partner signals.
Score low when: only owned channels; no independent mentions; no reviews; no press; AI has no external confirmation this business exists.
DIFFERENCE (0–25)
What is actually being scored: whether AI can articulate a specific reason to choose this business over alternatives in the same category.
Score high when: a clear, specific differentiator is present and machine-readable; positioning is not generic; a reasonable person could explain why this business over another.
Score low when: copy is interchangeable with any competitor; no stated or implied differentiator; AI would struggle to justify selecting this one specifically.
EASE (0–25)
What is actually being scored: the technical readiness of this business to be surfaced and selected by AI.
Score high when: JSON-LD schema present; FAQ schema present; LocalBusiness or Organization schema present; sitemap exists; llms.txt present; Open Graph tags complete; canonical tag set.
Score low when: no schema; no structured data; pages are not AI-readable; no sitemap; no llms.txt.
STRICT RULES:
- Use only the evidence provided. Do not invent signals.
- If a signal is absent, score accordingly. Do not assume it exists.
- If website content is strong but citations are absent, trust must be low regardless of clarity.
- If schema is missing entirely, ease cannot exceed 8.
- Be strict. A score of 20+ on any pillar requires clear evidence.
Competitive positioning tier — must be one of:
dominant, strong, upper_mid, mid, weak, absent
Tier label mapping:
- dominant → Category leader
- strong → Strong competitor
- upper_mid → Competing but not leading
- mid → Present but not competitive
- weak → Struggling to compete
- absent → Not in the competitive set
Return one short signature line: 3–6 words, final, decision-state based.
Decision state — must be one of:
not_seen, seen_not_considered, considered_not_chosen, trusted_not_chosen, chosen_by_default
summaryParagraph — exactly 3 sentences:
- Sentence 1 must start: "This business is not the obvious choice because..."
- Sentence 2 states the reason simply
- Sentence 3 states the consequence
Each pillar finding — one short sentence, 3–6 words, no commas, no explanation, must feel final.
Each action body — maximum 15 words. Be specific and direct.
evidenceNarrative — maximum 2 sentences. State what was found and what was missing.
Return ONLY raw JSON.
Do NOT include markdown.
Do NOT include backticks.
Do NOT include explanation.
Start directly with { and end with }.
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
}`;
}

module.exports = { scoreWithClaude };
