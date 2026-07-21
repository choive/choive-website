// Low-cost, independently attributed Gemini and Perplexity measurements.
// Each provider answers the same three unbranded buyer questions once.

'use strict';

// Gemini 3.1 Flash-Lite is retired. Use a current grounded model and retain a
// stable fallback. Perplexity Pro is the closer research-quality analogue to
// its consumer recommendation experience than the base low-cost Sonar model.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_FALLBACK_MODEL = 'gemini-3-flash-preview';
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar-pro';
const REQUEST_TIMEOUT_MS = 60000;

function normalize(value) {
  var text = String(value || '').toLowerCase();
  try { text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return text.replace(/\u00df/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

function stem(value) {
  return normalize(value).split(' ').filter(Boolean).map(function(word) {
    return word.length > 3 && word[word.length - 1] === 's' ? word.slice(0, -1) : word;
  }).join(' ');
}

function businessMentioned(response, name) {
  var haystack = ' ' + stem(response) + ' ';
  var needle = stem(name).replace(/\b(gmbh|ag|kg|ug|inc|llc|ltd|co|company)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (needle && haystack.indexOf(' ' + needle + ' ') !== -1) return true;
  var tokens = normalize(name).split(' ').filter(Boolean);
  if (tokens.length >= 3 && tokens.some(function(token) { return /\d/.test(token); })) {
    var acronym = tokens.map(function(token) { return /^\d+$/.test(token) ? token : token.charAt(0); }).join('');
    return normalize(response).replace(/\s+/g, '').indexOf(acronym) !== -1;
  }
  return false;
}

function cleanResponse(value) {
  var cleaned = String(value || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

function extractTopRecommendation(response, subjectName) {
  var text = String(response || '');
  var matches = text.match(/(?:^|\n)TOP_RECOMMENDATION\s*:\s*([^\n]+)/i);
  if (!matches) return null;
  var candidate = matches[1].replace(/\[[^\]]*\]/g, '').replace(/[.;]+$/, '').trim().slice(0, 100);
  if (!candidate || /^(none|no named recommendation|not established)$/i.test(candidate)) return null;
  return candidate;
}

function providerPrompt(source) {
  var sourceInstruction = String(source.system || '').trim();
  return (sourceInstruction ? sourceInstruction + '\n\n' : '')
    + String(source.query || '') + '\n\n'
    + 'Search current public sources before answering. Answer the buyer naturally and name real companies only. Use each company\'s exact current public brand name, not a guessed abbreviation, domain, legacy owner, or translated name. '
    + 'At the very end, add exactly one separate line in this format: TOP_RECOMMENDATION: Company Name. '
    + 'Use the single company you most clearly recommend for this exact question. If you do not recommend a specific company, write TOP_RECOMMENDATION: NONE.';
}

async function requestGeminiWithModel(source, model) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: providerPrompt(source) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0, maxOutputTokens: 900 }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      var errorText = await response.text().catch(function() { return ''; });
      var error = new Error('Gemini HTTP ' + response.status + (errorText ? ': ' + errorText.slice(0, 240) : ''));
      error.status = response.status;
      throw error;
    }
    var data = await response.json();
    return (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
      .map(function(part) { return part && part.text || ''; }).join('\n').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function requestGemini(source) {
  try {
    return await requestGeminiWithModel(source, GEMINI_MODEL);
  } catch (error) {
    if ((error.status === 400 || error.status === 404) && GEMINI_MODEL !== GEMINI_FALLBACK_MODEL) {
      return requestGeminiWithModel(source, GEMINI_FALLBACK_MODEL);
    }
    throw error;
  }
}

async function requestPerplexity(source) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var response = await fetch('https://api.perplexity.ai/v1/sonar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.PERPLEXITY_API_KEY },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: 'You are a buyer research assistant. Use current web evidence and name real companies only.' },
          { role: 'user', content: providerPrompt(source) }
        ],
        max_tokens: 900,
        temperature: 0
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error('Perplexity HTTP ' + response.status);
    var data = await response.json();
    return data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim() : '';
  } finally {
    clearTimeout(timer);
  }
}

async function runProvider(provider, input, requestFn, configured) {
  var sources = Array.isArray(input && input.sourceResults)
    ? input.sourceResults.filter(function(source) { return source && source.query; }).slice(0, 4)
    : [];
  if (!configured) return { available: false, configured: false, provider: provider, status: 'not_configured', results: [] };
  if (!sources.length) return { available: false, configured: true, provider: provider, status: 'no_queries', results: [] };

  var settled = await Promise.allSettled(sources.map(requestFn));
  var results = sources.map(function(source, index) {
    var raw = settled[index].status === 'fulfilled' ? settled[index].value : '';
    var response = cleanResponse(raw);
    return {
      label: source.label,
      intent: source.intent,
      query: source.query,
      response: response,
      appeared: businessMentioned(response, input.name),
      appearedCount: businessMentioned(response, input.name) ? 1 : 0,
      sampleCount: response ? 1 : 0,
      allResponses: response ? [response] : [],
      topRecommendation: extractTopRecommendation(raw, input.name),
      error: settled[index].status === 'rejected' ? String(settled[index].reason && settled[index].reason.message || 'Request failed') : null
    };
  });
  var replacement = results.filter(function(result) { return String(result.label || '').toLowerCase().indexOf('branded replacement') !== -1; })[0];
  var buyerResults = results.filter(function(result) { return String(result.label || '').toLowerCase().indexOf('branded replacement') === -1; });
  // Only the explicit branded "who instead?" question populates this lane.
  // Unbranded discovery answers remain visibility evidence.
  var chosen = replacement && replacement.topRecommendation ? replacement : null;
  var completed = results.filter(function(result) { return result.sampleCount === 1; }).length;
  var failureReasons = results.map(function(result) { return result.error; }).filter(Boolean);
  if (failureReasons.length) {
    console.warn('[' + provider + '-simulation] ' + failureReasons.join(' | '));
  }
  return {
    available: completed > 0,
    configured: true,
    complete: completed === sources.length,
    provider: provider,
    model: provider === 'gemini' ? GEMINI_MODEL : PERPLEXITY_MODEL,
    status: completed === sources.length ? 'complete' : (completed > 0 ? 'partial' : 'failed'),
    completedSamples: completed,
    expectedSamples: sources.length,
    appearedCount: buyerResults.filter(function(result) { return result.appeared; }).length,
    totalQueries: buyerResults.length,
    topRecommendation: chosen ? chosen.topRecommendation : null,
    competitorRecommendation: chosen ? chosen.topRecommendation : null,
    competitorRecommendationQuery: replacement ? replacement.query : null,
    recommendationQuery: replacement ? replacement.query : null,
    recommendationResponse: replacement ? replacement.response : null,
    recommendationCompleted: Boolean(replacement && replacement.sampleCount === 1),
    recommendationError: replacement && replacement.error || null,
    reason: completed === 0 ? (failureReasons[0] || 'No platform response was returned') : null,
    results: results
  };
}

function runGeminiSimulation(input) {
  return runProvider('gemini', input, requestGemini, Boolean(process.env.GEMINI_API_KEY));
}

function runPerplexitySimulation(input) {
  return runProvider('perplexity', input, requestPerplexity, Boolean(process.env.PERPLEXITY_API_KEY));
}

module.exports = { runGeminiSimulation: runGeminiSimulation, runPerplexitySimulation: runPerplexitySimulation };
