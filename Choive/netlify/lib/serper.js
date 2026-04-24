// lib/serper.js
// CHOIVE™ Serper search + normalization helpers
// ENV:
// SERPER_API_KEY

const SERPER_URL = 'https://google.serper.dev/search';
const TIMEOUT_MS = 6000;
const MAX_RESULTS = 5;

function safeString(value, maxLength = 0) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (!maxLength || str.length <= maxLength) return str;
  return str.slice(0, maxLength);
}

function normalizeUrl(url) {
  if (!url) return '';

  let value = String(url).trim().toLowerCase();

  value = value.replace(/^https?:\/\//i, '');
  value = value.replace(/^www\./i, '');
  value = value.split('/')[0];
  value = value.split('?')[0];
  value = value.split('#')[0];

  return value;
}

function normalizeNameForMatch(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function searchSerper(name, category, city) {
  if (!process.env.SERPER_API_KEY) {
    throw new Error('Missing SERPER_API_KEY');
  }

  const query = [name, category, city].filter(Boolean).join(' ').trim();

  if (!query) {
    throw new Error('Serper query is empty');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: query,
        num: MAX_RESULTS + 1
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Serper HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();

    return normalizeSerperResults(
      Array.isArray(data?.organic) ? data.organic.slice(0, MAX_RESULTS) : [],
      data?.knowledgeGraph || null
    );
  } catch (error) {
    clearTimeout(timeout);

    if (error.name === 'AbortError') {
      throw new Error('Serper request timed out');
    }

    throw error;
  }
}

function normalizeSerperResults(organic, knowledgeGraph) {
  const results = organic.map((item, index) => ({
    position: index + 1,
    title: safeString(item?.title, 120),
    snippet: safeString(item?.snippet, 220),
    link: safeString(item?.link, 300)
  }));

  const kg = knowledgeGraph
    ? {
        title: safeString(knowledgeGraph.title, 120),
        type: safeString(knowledgeGraph.type, 80),
        website: safeString(knowledgeGraph.website, 300),
        description: safeString(knowledgeGraph.description, 300)
      }
    : null;

  const searchText = results.length
    ? results.map(result => `${result.position}. ${result.title} — ${result.snippet}`).join('\n')
    : 'No search results returned.';

  const kgText = kg
    ? `Title: ${kg.title}; Type: ${kg.type}; Website: ${kg.website}; Description: ${kg.description}`
    : 'None';

  return {
    results,
    knowledgeGraph: kg,
    searchText,
    kgText
  };
}

function inferOfficialSite(website, serperPayload, name) {
  if (website) return website;

  const results = serperPayload?.results || [];
  const knowledgeGraph = serperPayload?.knowledgeGraph || null;

  const normalizedName = normalizeNameForMatch(name);
  const kgDomain = normalizeUrl(knowledgeGraph?.website || '');

  const matchedResult = results.find(result => {
    const domain = normalizeUrl(result.link);
    const flattenedDomain = domain.replace(/[^a-z0-9]/g, '');

    return (
      (normalizedName && flattenedDomain.includes(normalizedName)) ||
      (kgDomain && domain === kgDomain)
    );
  });

  return matchedResult?.link || knowledgeGraph?.website || '';
}

module.exports = {
  searchSerper,
  inferOfficialSite,
  normalizeUrl
};
