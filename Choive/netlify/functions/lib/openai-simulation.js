// OpenAI buyer-answer measurement for CHOIVE.
// Uses the exact queries already generated for the Claude simulation so the
// platform comparison measures model behavior, not differences in prompting.
// ENV: OPENAI_API_KEY. Optional: OPENAI_MODEL, OPENAI_GROUND_TRUTH_SAMPLES.

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6';
const REQUEST_TIMEOUT_MS = 60000;

function sampleCount() {
  var configured = Number(process.env.OPENAI_GROUND_TRUTH_SAMPLES || 2);
  if (!Number.isFinite(configured)) configured = 2;
  return Math.max(1, Math.min(4, Math.floor(configured)));
}

function outputText(data) {
  if (data && typeof data.output_text === 'string') return data.output_text.trim();
  var parts = [];
  (data && Array.isArray(data.output) ? data.output : []).forEach(function(item) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) return;
    item.content.forEach(function(content) {
      if (content && content.type === 'output_text' && content.text) parts.push(content.text);
    });
  });
  return parts.join('\n').trim();
}

function cleanResponse(response) {
  if (!response) return '';
  var cleaned = String(response)
    .replace(/[#]+ /g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*] /gm, '\u2022 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length > 900) {
    var cut = cleaned.lastIndexOf('.', 900);
    cleaned = cut > 300 ? cleaned.slice(0, cut + 1) : cleaned.slice(0, 900);
  }
  return cleaned;
}

function normalize(s) {
  s = String(s || '').toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return s.replace(/\u00df/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

function businessMentioned(response, name) {
  var haystack = ' ' + normalize(response) + ' ';
  var needle = normalize(name)
    .replace(/\b(gmbh|ag|kg|ug|inc|llc|ltd|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return !!needle && haystack.indexOf(' ' + needle + ' ') !== -1;
}

async function requestOpenAI(systemPrompt, query, useSearch) {
  if (!process.env.OPENAI_API_KEY) return null;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var body = {
      model: OPENAI_MODEL,
      instructions: systemPrompt,
      input: query,
      max_output_tokens: 1200,
      store: false
    };
    if (useSearch) body.tools = [{ type: 'web_search', search_context_size: 'medium' }];
    var res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      var errText = await res.text().catch(function() { return ''; });
      console.warn('[openai-simulation] API returned ' + res.status + ': ' + errText.slice(0, 240));
      return null;
    }
    return outputText(await res.json());
  } catch (err) {
    clearTimeout(timer);
    console.warn('[openai-simulation] request failed:', err.message);
    return null;
  }
}

async function extractRecommendations(name, category, city, results) {
  var transcripts = [];
  (results || []).forEach(function(result) {
    (result.allResponses || []).forEach(function(response) {
      if (response) transcripts.push(response);
    });
  });
  if (!transcripts.length) return null;

  var prompt =
    'Extract the companies that these OpenAI buyer answers recommend as alternatives to the subject.\n'
    + 'Subject: ' + name + '\nCategory: ' + category + '\nMarket: ' + (city || 'not specified') + '\n\n'
    + transcripts.map(function(text, i) { return 'Answer ' + (i + 1) + ':\n' + text; }).join('\n\n')
    + '\n\nReturn JSON only with this shape: '
    + '{"primary":"Brand name or empty","second":"Brand name or empty","third":"Brand name or empty"}. '
    + 'Use exact public brand names. Exclude the subject, platforms, generic categories, customers, suppliers, and companies outside the serviceable market.';

  var raw = await requestOpenAI(
    'You extract verifiable business names from supplied transcripts. Return only valid JSON.',
    prompt,
    false
  );
  if (!raw) return null;
  try {
    var clean = raw.replace(/```json|```/g, '').trim();
    var jsonStart = clean.indexOf('{');
    var jsonEnd = clean.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) clean = clean.slice(jsonStart, jsonEnd + 1);
    var parsed = JSON.parse(clean);
    var names = [parsed.primary, parsed.second, parsed.third]
      .map(function(value) { return String(value || '').trim(); })
      .filter(Boolean)
      .filter(function(value) { return normalize(value) !== normalize(name); });
    var seen = {};
    names = names.filter(function(value) {
      var key = normalize(value);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
    return {
      primary: names[0] || null,
      second: names[1] || null,
      third: names[2] || null
    };
  } catch (err) {
    console.warn('[openai-simulation] recommendation extraction failed:', err.message);
    return null;
  }
}

async function runOpenAISimulation(input) {
  if (!process.env.OPENAI_API_KEY) {
    return { available: false, provider: 'openai', reason: 'OPENAI_API_KEY is not configured' };
  }
  var sourceResults = input && input.sourceResults;
  if (!Array.isArray(sourceResults) || !sourceResults.length) {
    return { available: false, provider: 'openai', reason: 'No shared buyer queries were supplied' };
  }

  var samples = sampleCount();
  var jobs = [];
  sourceResults.forEach(function(result, queryIndex) {
    for (var i = 0; i < samples; i++) jobs.push({ queryIndex: queryIndex, result: result });
  });
  var settled = await Promise.allSettled(jobs.map(function(job) {
    var system = 'You are a helpful AI assistant with live web search. Search before answering. '
      + 'Name specific, real companies that serve the buyer\'s market. Be concrete and explain the recommendation briefly.';
    return requestOpenAI(system, job.result.query, true);
  }));

  var grouped = sourceResults.map(function() { return []; });
  settled.forEach(function(outcome, index) {
    var text = outcome.status === 'fulfilled' ? cleanResponse(outcome.value) : '';
    if (text) grouped[jobs[index].queryIndex].push(text);
  });
  var results = sourceResults.map(function(source, index) {
    var responses = grouped[index];
    var appearances = responses.filter(function(response) { return businessMentioned(response, input.name); });
    return {
      label: source.label,
      intent: source.intent,
      query: source.query,
      response: appearances[0] || responses[0] || '',
      appeared: appearances.length > 0,
      appearedCount: appearances.length,
      sampleCount: responses.length,
      allResponses: responses
    };
  });
  var recommendations = await extractRecommendations(
    input.name,
    input.category || '',
    input.city || '',
    results
  );
  return {
    available: results.some(function(result) { return result.sampleCount > 0; }),
    provider: 'openai',
    model: OPENAI_MODEL,
    language: input.language || null,
    sampleCountPerQuery: samples,
    appearedCount: results.filter(function(result) { return result.appeared; }).length,
    totalQueries: results.length,
    recommendations: recommendations,
    results: results
  };
}

module.exports = { runOpenAISimulation: runOpenAISimulation };
