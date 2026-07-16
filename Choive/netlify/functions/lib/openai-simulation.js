// OpenAI buyer-answer measurement for CHOIVE.
// Uses the exact queries already generated for the Claude simulation so the
// platform comparison measures model behavior, not differences in prompting.
// ENV: OPENAI_API_KEY. Optional: OPENAI_MODEL, OPENAI_GROUND_TRUTH_SAMPLES.

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_FALLBACK_MODEL = 'gpt-5-mini';
const REQUEST_TIMEOUT_MS = 90000;

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

function cleanResponse(response, maxLength) {
  if (!response) return '';
  maxLength = Number(maxLength || 900);
  var cleaned = String(response)
    .replace(/[#]+ /g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*] /gm, '\u2022 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length > maxLength) {
    var cut = cleaned.lastIndexOf('.', maxLength);
    cleaned = cut > 300 ? cleaned.slice(0, cut + 1) : cleaned.slice(0, maxLength);
  }
  return cleaned;
}

function normalize(s) {
  s = String(s || '').toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return s.replace(/\u00df/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

function stemWords(s) {
  return normalize(s).split(' ').filter(Boolean).map(function(word) {
    return word.length > 3 && word[word.length - 1] === 's' ? word.slice(0, -1) : word;
  }).join(' ');
}

function businessMentioned(response, name) {
  var haystack = ' ' + stemWords(response) + ' ';
  var needle = stemWords(name)
    .replace(/\b(gmbh|ag|kg|ug|inc|llc|ltd|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (needle && haystack.indexOf(' ' + needle + ' ') !== -1) return true;

  // Recognize established compact brand forms such as "3SS" for
  // "3 Screen Solutions" without applying broad acronym matching to ordinary
  // multi-word businesses.
  var tokens = normalize(name).split(' ').filter(Boolean);
  if (tokens.length >= 3 && tokens.some(function(token) { return /\d/.test(token); })) {
    var acronym = tokens.map(function(token) {
      return /^\d+$/.test(token) ? token : token.charAt(0);
    }).join('');
    var compactResponse = normalize(response).replace(/\s+/g, '');
    if (acronym.length >= 3 && compactResponse.indexOf(acronym) !== -1) return true;
  }
  return false;
}

async function requestOpenAIWithModel(systemPrompt, query, useSearch, model) {
  if (!process.env.OPENAI_API_KEY) return null;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var body = {
      model: model,
      instructions: systemPrompt,
      input: query,
      // GPT-5 models may spend part of this allowance on reasoning. A 1,200
      // token cap produced live answers such as "Meine klare" and then stopped
      // before the recommendation. Keep reasoning low and leave enough room
      // for a searched answer plus citations.
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      max_output_tokens: 3200,
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
      var error = new Error('OpenAI HTTP ' + res.status + (errText ? ': ' + errText.slice(0, 240) : ''));
      error.status = res.status;
      throw error;
    }
    return outputText(await res.json());
  } catch (err) {
    clearTimeout(timer);
    console.warn('[openai-simulation] request failed:', err.message);
    throw err;
  }
}

async function requestOpenAI(systemPrompt, query, useSearch) {
  try {
    return await requestOpenAIWithModel(systemPrompt, query, useSearch, OPENAI_MODEL);
  } catch (error) {
    if ((error.status === 400 || error.status === 404) && OPENAI_MODEL !== OPENAI_FALLBACK_MODEL) {
      return requestOpenAIWithModel(systemPrompt, query, useSearch, OPENAI_FALLBACK_MODEL);
    }
    throw error;
  }
}

async function extractRecommendations(name, category, city, results, mode) {
  var transcripts = [];
  // Keep unbranded buyer recommendations separate from branded competitor
  // research. The latter is useful for market-fit adjudication, but it cannot
  // truthfully describe what the platform recommends before the subject is
  // named.
  var namedShortlistResults = (results || []).filter(function(result) {
    return String(result && result.label || '').toLowerCase().indexOf('named competitor') !== -1
      && Array.isArray(result.allResponses)
      && result.allResponses.some(Boolean);
  });
  var directRecommendationResults = (results || []).filter(function(result) {
    return String(result && result.label || '').toLowerCase().indexOf('direct recommendation') !== -1
      && Array.isArray(result.allResponses)
      && result.allResponses.some(Boolean);
  });
  var extractionResults;
  if (mode === 'competitor-shortlist') {
    extractionResults = namedShortlistResults;
  } else {
    extractionResults = directRecommendationResults.length
      ? directRecommendationResults
      : (results || []).filter(function(result) {
          return String(result && result.label || '').toLowerCase().indexOf('named competitor') === -1;
        });
  }
  extractionResults.forEach(function(result) {
    (result.allResponses || []).forEach(function(response) {
      if (response) transcripts.push(response);
    });
  });
  if (!transcripts.length) return null;

  var prompt =
    'Extract and rank the top three companies that these OpenAI buyer answers identify as direct alternatives to the subject. When samples disagree, rank by closest overall purchasing substitute: same product scope, same buyers, same commercial model, and same serviceable markets. For a subject spanning multiple buyer markets, a competitor credibly spanning those same markets outranks a specialist that overlaps in only one. Use repeated mentions and stated answer order only as secondary tie-breakers.\n'
    + 'Subject: ' + name + '\nCategory: ' + category + '\nMarket: ' + (city || 'not specified') + '\n\n'
    + transcripts.map(function(text, i) { return 'Answer ' + (i + 1) + ':\n' + text; }).join('\n\n')
    + '\n\nReturn JSON only with this shape: '
    + '{"primary":"Brand name or empty","second":"Brand name or empty","third":"Brand name or empty"}. '
    + 'Use exact public brand names. Exclude the subject, platforms, generic categories, customers, suppliers, and companies outside the serviceable market.';

  var raw;
  try {
    raw = await requestOpenAI(
      'You extract verifiable business names from supplied transcripts. Return only valid JSON.',
      prompt,
      false
    );
  } catch (error) {
    console.warn('[openai-simulation] recommendation extraction request failed:', error.message);
    return null;
  }
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
  var errors = sourceResults.map(function() { return []; });
  settled.forEach(function(outcome, index) {
    var sourceLabel = String(jobs[index] && jobs[index].result && jobs[index].result.label || '').toLowerCase();
    // Competitor research answers begin by explaining the subject. Preserve
    // enough of the answer to reach the actual shortlist and recommendation.
    var responseLimit = sourceLabel.indexOf('named competitor') !== -1 ? 2800 : 1200;
    var text = outcome.status === 'fulfilled' ? cleanResponse(outcome.value, responseLimit) : '';
    if (text) grouped[jobs[index].queryIndex].push(text);
    if (outcome.status === 'rejected') {
      errors[jobs[index].queryIndex].push(String(outcome.reason && outcome.reason.message || 'Request failed'));
    }
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
      allResponses: responses,
      error: errors[index][0] || null
    };
  });
  var recommendations = await extractRecommendations(
    input.name,
    input.category || '',
    input.city || '',
    results,
    'buyer-recommendation'
  );
  var competitorShortlist = await extractRecommendations(
    input.name,
    input.category || '',
    input.city || '',
    results,
    'competitor-shortlist'
  );
  var visibilityResults = results.filter(function(result) {
    return String(result && result.label || '').toLowerCase().indexOf('named competitor') === -1;
  });
  return {
    available: results.some(function(result) { return result.sampleCount > 0; }),
    complete: results.every(function(result) { return result.sampleCount === samples; }),
    configured: true,
    status: results.every(function(result) { return result.sampleCount === samples; })
      ? 'complete'
      : (results.some(function(result) { return result.sampleCount > 0; }) ? 'partial' : 'failed'),
    completedSamples: results.reduce(function(total, result) { return total + result.sampleCount; }, 0),
    expectedSamples: results.length * samples,
    provider: 'openai',
    model: OPENAI_MODEL,
    language: input.language || null,
    sampleCountPerQuery: samples,
    appearedCount: visibilityResults.filter(function(result) { return result.appeared; }).length,
    totalQueries: visibilityResults.length,
    recommendations: recommendations,
    competitorShortlist: competitorShortlist,
    results: results
  };
}

module.exports = { runOpenAISimulation: runOpenAISimulation };
