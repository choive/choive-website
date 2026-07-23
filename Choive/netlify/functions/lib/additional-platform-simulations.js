// Low-cost, independently attributed Gemini and Perplexity measurements.
// Each provider answers visibility questions once and the direct recommendation
// question multiple times so consensus does not multiply every provider call.

'use strict';

// Use the current grounded Gemini model with a stable lower-latency fallback.
// Perplexity Pro is the closer research-quality analogue to
// its consumer recommendation experience than the base low-cost Sonar model.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Use a separate stable, lower-latency model when the primary model is under
// capacity pressure. A preview from the same high-demand family is not a
// reliable fallback during a regional availability spike.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar-pro';
const REQUEST_TIMEOUT_MS = 75000;
const { majorityRecommendation } = require('./recommendation-consensus');
const { recommendationSampleCount, samplesForQuestion, strictMajorityThreshold } = require('./measurement-policy');

function isTransientProviderError(error) {
  var status = Number(error && error.status || 0);
  var message = String(error && error.message || '').toLowerCase();
  return status === 429 || status >= 500
    || (error && error.name === 'AbortError')
    || /abort|timed?\s*out|timeout|temporar|high demand|fetch failed/.test(message);
}

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
  // Providers frequently bold the required marker or return the company as a
  // Markdown link. Parse the same cleaned text that is stored and displayed.
  var text = cleanResponse(response);
  var matches = text.match(/(?:^|\n)TOP_RECOMMENDATION\s*:\s*([^\n]+)/i);
  // Gemini can occasionally reach its response-token limit after giving an
  // explicit recommendation but before printing the requested marker. Accept
  // only clear recommendation wording in that case; never infer from a list.
  if (!matches) {
    matches = text.match(/\b(?:I|we)\s+(?:would\s+)?(?:highly\s+|strongly\s+)?recommend\s+(?:the\s+)?(?:company\s+)?(?:\*\*)?([A-Z0-9][A-Za-z0-9&.'’+\- ]{1,80})/);
  }
  if (!matches) {
    matches = text.match(/\b(?:top|first|strongest|best)\s+(?:single\s+)?(?:recommendation|alternative|choice|option)\s*(?:is|would be|:)\s*([A-Z0-9][A-Za-z0-9&.'’+\- ]{1,80})/i);
  }
  if (!matches) return null;
  var candidate = matches[1]
    .split(/\s+(?:as|because|for|instead|over|which|whose|that)\b/i)[0]
    .replace(/\[[^\]]*\]/g, '').replace(/\*+/g, '').replace(/[,:;.!?]+$/, '').trim().slice(0, 100);
  if (!candidate || /^(none|no named recommendation|not established)$/i.test(candidate)) return null;
  return candidate;
}

function hasExplicitNoRecommendation(response) {
  var text = cleanResponse(response);
  return /(?:^|\n)TOP_RECOMMENDATION\s*:\s*(?:NONE|NO NAMED RECOMMENDATION|NOT ESTABLISHED)\s*(?:$|\n)/i.test(text);
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
        generationConfig: {
          maxOutputTokens: 1400,
          thinkingConfig: { thinkingLevel: 'minimal' }
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      var errorText = await response.text().catch(function() { return ''; });
      var error = new Error('Gemini ' + model + ' HTTP ' + response.status + (errorText ? ': ' + errorText.slice(0, 240) : ''));
      error.status = response.status;
      throw error;
    }
    var data = await response.json();
    return {
      text: (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
        .filter(function(part) { return part && !part.thought; })
        .map(function(part) { return part.text || ''; }).join('\n').trim(),
      model: model
    };
  } finally {
    clearTimeout(timer);
  }
}

async function requestGemini(source) {
  try {
    return await requestGeminiWithModel(source, GEMINI_MODEL);
  } catch (error) {
    // Capacity errors and request timeouts are not negative measurements.
    // Move directly to the independent fallback model after a short pause;
    // retrying the same overloaded model wastes time and can exceed the
    // background function budget.
    if (isTransientProviderError(error)) {
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    }
    if ((error.status === 400 || error.status === 404 || isTransientProviderError(error))
      && GEMINI_MODEL !== GEMINI_FALLBACK_MODEL) {
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
  var suppliedSources = Array.isArray(input && input.sourceResults)
    ? input.sourceResults.filter(function(source) { return source && source.query; }) : [];
  var replacementSource = suppliedSources.find(function(source) {
    return /branded replacement/i.test(String(source.label || ''));
  });
  var sources = suppliedSources.filter(function(source) {
    return !/branded replacement/i.test(String(source.label || ''));
  }).slice(0, 3);
  if (replacementSource) sources.push(replacementSource);
  if (!configured) return { available: false, configured: false, provider: provider, status: 'not_configured', results: [] };
  if (!sources.length) return { available: false, configured: true, provider: provider, status: 'no_queries', results: [] };

  var jobs = [];
  sources.forEach(function(source, sourceIndex) {
    var expected = samplesForQuestion(source, true);
    for (var sampleIndex = 0; sampleIndex < expected; sampleIndex++) {
      jobs.push({ source: source, sourceIndex: sourceIndex });
    }
  });
  var settled;
  if (provider === 'gemini') {
    // Avoid sending all grounded searches to a model that may
    // temporarily throttle burst traffic. Two-at-a-time preserves reasonable
    // latency without turning capacity spikes into partial diagnostics.
    settled = [];
    for (var batchStart = 0; batchStart < jobs.length; batchStart += 2) {
      var batch = await Promise.allSettled(jobs.slice(batchStart, batchStart + 2).map(function(job) {
        return requestFn(job.source);
      }));
      settled = settled.concat(batch);
    }
  } else {
    settled = await Promise.allSettled(jobs.map(function(job) { return requestFn(job.source); }));
  }
  var grouped = sources.map(function() { return []; });
  var groupedErrors = sources.map(function() { return []; });
  var groupedModels = sources.map(function() { return []; });
  settled.forEach(function(outcome, jobIndex) {
    var sourceIndex = jobs[jobIndex].sourceIndex;
    if (outcome.status === 'rejected') {
      groupedErrors[sourceIndex].push(String(outcome.reason && outcome.reason.message || 'Request failed'));
      return;
    }
    var value = outcome.value;
    var raw = value && typeof value === 'object' ? String(value.text || '') : String(value || '');
    var cleaned = cleanResponse(raw);
    if (cleaned) grouped[sourceIndex].push(cleaned);
    if (value && typeof value === 'object' && value.model) groupedModels[sourceIndex].push(value.model);
  });
  var results = sources.map(function(source, index) {
    var responses = grouped[index];
    var appearances = responses.filter(function(response) { return businessMentioned(response, input.name); });
    var consensus = majorityRecommendation(
      responses.map(function(response) { return extractTopRecommendation(response, input.name); }).filter(Boolean),
      responses.length
    );
    return {
      label: source.label,
      intent: source.intent,
      query: source.query,
      response: appearances[0] || responses[0] || '',
      appeared: appearances.length > 0,
      appearedCount: appearances.length,
      sampleCount: responses.length,
      expectedSamples: samplesForQuestion(source, true),
      allResponses: responses,
      model: groupedModels[index].filter(function(value, position, values) { return values.indexOf(value) === position; }).join(', ') || null,
      topRecommendation: consensus.name,
      recommendationCounts: consensus.counts,
      recommendationAgreement: consensus,
      error: groupedErrors[index][0] || null
    };
  });
  var replacement = results.filter(function(result) { return String(result.label || '').toLowerCase().indexOf('branded replacement') !== -1; })[0];
  var replacementMajorityThreshold = replacement && replacement.sampleCount > 0
    ? strictMajorityThreshold(replacement.sampleCount) : 0;
  var explicitNoRecommendation = Boolean(replacement && replacement.sampleCount > 0
    && replacement.allResponses.filter(hasExplicitNoRecommendation).length >= replacementMajorityThreshold);
  var buyerResults = results.filter(function(result) { return String(result.label || '').toLowerCase().indexOf('branded replacement') === -1; });
  // Only the explicit branded "who instead?" question populates this lane.
  // Unbranded discovery answers remain visibility evidence.
  var chosen = replacement && replacement.topRecommendation ? replacement : null;
  var completed = results.reduce(function(total, result) { return total + result.sampleCount; }, 0);
  var expected = results.reduce(function(total, result) { return total + result.expectedSamples; }, 0);
  var failureReasons = results.map(function(result) { return result.error; }).filter(Boolean);
  var actualModels = results.map(function(result) { return result.model; }).filter(Boolean)
    .filter(function(value, index, values) { return values.indexOf(value) === index; });
  if (failureReasons.length) {
    console.warn('[' + provider + '-simulation] ' + failureReasons.join(' | '));
  }
  if (replacement && replacement.sampleCount > 0 && !replacement.topRecommendation && !explicitNoRecommendation) {
    console.warn('[' + provider + '-simulation] Branded replacement answer completed but no recommendation name could be extracted.');
  }
  return {
    available: completed > 0,
    configured: true,
    complete: completed === expected,
    provider: provider,
    model: provider === 'gemini' ? (actualModels.join(', ') || GEMINI_MODEL) : PERPLEXITY_MODEL,
    status: completed === expected ? 'complete' : (completed > 0 ? 'partial' : 'failed'),
    completedSamples: completed,
    expectedSamples: expected,
    sampleCountPerQuery: 1,
    recommendationSamples: recommendationSampleCount(),
    appearedCount: buyerResults.filter(function(result) { return result.appeared; }).length,
    totalQueries: buyerResults.length,
    topRecommendation: chosen ? chosen.topRecommendation : null,
    competitorRecommendation: chosen ? chosen.topRecommendation : null,
    competitorRecommendationQuery: replacement ? replacement.query : null,
    recommendationQuery: replacement ? replacement.query : null,
    recommendationResponse: replacement ? replacement.response : null,
    recommendationCompleted: Boolean(replacement && replacement.sampleCount > 0
      && (replacement.topRecommendation || explicitNoRecommendation)),
    explicitNoRecommendation: explicitNoRecommendation,
    recommendationError: replacement && replacement.error
      || (replacement && replacement.sampleCount > 0 && !replacement.topRecommendation && !explicitNoRecommendation
        ? 'The provider answered, but no recommendation reached majority agreement across the recorded samples.' : null),
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
