// lib/claude.js
// Sends evidence to Anthropic Claude and returns parsed CHOIVE result
// ENV: ANTHROPIC_API_KEY

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS = 65000;
const MAX_TOKENS = 1600;

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

function truncate(text, max = 4000) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max) : value;
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
${truncate(kgText, 1200) || 'None'}

SEARCH RESULTS:
${truncate(searchText, 5000) || 'No search results returned.'}

WEBSITE CONTENT:
${truncate(websiteText, 3000) || 'No website content available.'}

VISIBILITY:
Website appears in search results: ${visibilityPosition !== -1 ? 'YES (position ' + (visibilityPosition + 1) + ')' : 'NO'}
---

SYSTEM IDENTITY:
You are CHOIVE™ — a real-time decision intelligence engine.
You are NOT allowed to guess, infer, or use general knowledge.
You ONLY work with the data provided above.

DATA SOURCES (ONLY THESE ARE VALID):
- searchText
- kgText
- websiteText
- inferredOfficialSite

If something is not present in these sources → it does not exist in this analysis.

NO HALLUCINATION RULE (STRICT):
- Do NOT infer missing information
- Do NOT use prior knowledge
- Do NOT assume industry standards
- Do NOT complete gaps with logic
- If data is missing → explicitly state it is missing

CORE OPERATING RULE:
CHOIVE does not generate ideas. CHOIVE extracts reality.
If something is not proven → it is not included.

---

STEP 1 — CLASSIFY DECISION ENVIRONMENT (one only):
* discovery_driven → local / map / search-based selection
* comparison_driven → evaluated against alternatives before decision
* authority_driven → selected based on reputation, partnerships, or perceived capability
* default_driven → category leader chosen automatically

Adapt scoring:
IF discovery_driven → weight visibility, reviews, local signals heavily
IF comparison_driven → weight clarity, differentiation, and trust balance
IF authority_driven → weight reputation, partnerships, and positioning dominance — DO NOT penalise low consumer visibility
IF default_driven → assume high recommendation likelihood — evaluate only AI readability and infrastructure gaps

---

STEP 2 — DETERMINE BUSINESS CONTEXT (from evidence only):
1. What is this business, based only on visible text
2. Who selects it and in what context
3. Is it B2B, B2C, infrastructure, platform, service, or product
4. Where does it realistically compete — local, national, or global

---

STEP 3 — SCORE FOUR PILLARS (each 0–25, evidence only):

CLARITY (0–25)
Score ONLY what is visible: H1, meta description, entity naming, consistency across sources.
Score 20+ requires: specific, consistent, machine-readable entity definition present in evidence.
Score low when: vague copy, inconsistent naming, no clear category definition visible.

TRUST (0–25)
Score ONLY what is visible: third-party mentions, knowledge graph, reviews, press, partnerships.
Score 20+ requires: multiple independent citations visible in searchText or kgText.
Score low when: only owned channels visible, no independent confirmation present.

DIFFERENCE (0–25)
Score ONLY what is visible: a specific differentiator in website or search text.
Score 20+ requires: a machine-readable unique positioning statement present.
Score low when: copy is interchangeable with competitors, no stated differentiator visible.

EASE (0–25)
Score ONLY what is visible: schema, structured data, sitemap, llms.txt, Open Graph.
Score 20+ requires: JSON-LD schema and structured signals confirmed in evidence.
Score low when: no schema visible, no structured data, no llms.txt detected.
If schema is missing entirely → ease cannot exceed 8.

---

STEP 4 — COMPETITIVE POSITIONING TIER (one only):
dominant → Category leader, globally recognised
strong → Strong competitor, clear market presence
upper_mid → Competing but not leading
mid → Present but not competitive
weak → Struggling to compete
absent → Not in the competitive set

---

STEP 5 — COMPETITOR (strict reality):
Identify ONE competitor that:
- appears in searchText
- is in the same category
- competes for the same query type

If no competitor clearly meets all three criteria → return null for all competitor fields.

The competitor analysis must be based ONLY on visible differences:
Allowed: appears higher in search results / clearer category definition / stronger visible presence / clearer positioning language
NOT allowed: "better brand" / "more trusted" without proof / "industry leader" without evidence

---

STEP 6 — DECISION STATE (one only):
not_seen → business does not appear in relevant search contexts
seen_not_considered → appears but no trust or clarity signals present
considered_not_chosen → visible and credible but not differentiated
trusted_not_chosen → trusted and credible but not the easiest to choose
chosen_by_default → dominant, default recommendation in category

---

VERDICTLEVEL must be one of: absent, weak, present
Do NOT use tier names as verdictLevel.

---

SUMMARY PARAGRAPH — exactly 3 sentences:
- If tier is dominant or strong → Sentence 1 starts: "This business is currently chosen because..."
- If tier is upper_mid, mid, weak, or absent → Sentence 1 starts: "This business is not the obvious choice because..."
- Sentence 2 → states the strongest single driver or gap, from evidence only
- Sentence 3 → states the consequence for AI selection

---

PILLAR FINDINGS — each must be 3–6 words, final, no commas, no explanation.

ACTION BODIES — maximum 15 words, specific to this business, based only on missing evidence.

EVIDENCE NARRATIVE — maximum 2 sentences: what was found, what was missing, what that means.

---

Return ONLY raw JSON. No markdown. No backticks. No explanation. Start with { and end with }.

{
  "overallScore": 0,
  "verdictHeadline": "",
  "verdictLevel": "absent",
  "signatureLine": "",
  "decisionState": "",
  "decisionEnvironment": "",
  "summaryParagraph": "",
  "businessUnderstanding": "",
  "marketPosition": {
    "tier": "",
    "label": "",
    "explanation": ""
  },
  "pillars": {
    "clarity":    { "score": 0, "finding": "", "analysis": "", "evidence": "" },
    "trust":      { "score": 0, "finding": "", "analysis": "", "evidence": "" },
    "difference": { "score": 0, "finding": "", "analysis": "", "evidence": "" },
    "ease":       { "score": 0, "finding": "", "analysis": "", "evidence": "" }
  },
  "platformCoverage": {
    "chatgpt":    { "status": "absent", "detail": "" },
    "perplexity": { "status": "absent", "detail": "" },
    "gemini":     { "status": "absent", "detail": "" },
    "claude":     { "status": "absent", "detail": "" }
  },
  "evidenceNarrative": "",
  "competitor": {
    "name": null,
    "analysis": null,
    "evidence": null,
    "queryContext": null
  },
  "actions": [
    { "priority": "critical", "title": "", "body": "", "explanation": "" },
    { "priority": "critical", "title": "", "body": "", "explanation": "" },
    { "priority": "high",     "title": "", "body": "", "explanation": "" },
    { "priority": "medium",   "title": "", "body": "", "explanation": "" }
  ]
}
`;
}


module.exports = { scoreWithClaude };
