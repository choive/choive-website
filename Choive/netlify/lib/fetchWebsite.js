// lib/fetchWebsite.js
// CHOIVE™ website fetch + text extraction
// Safely fetches a website, strips noisy HTML, returns clean text
// Adds https:// if protocol is missing

const TIMEOUT_MS = 5000;
const MAX_TEXT_LENGTH = 2000;

function ensureProtocol(url) {
  if (!url) return '';
  const value = String(url).trim();
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractText(html) {
  if (!html || typeof html !== 'string') return '';

  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<form[\s\S]*?<\/form>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  ).slice(0, MAX_TEXT_LENGTH);
}

async function fetchWebsiteText(url) {
  if (!url) return '';

  const safeUrl = ensureProtocol(url);
  if (!safeUrl) return '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(safeUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CHOIVEBot/1.0)'
      },
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`CHOIVE fetchWebsite: non-200 for ${safeUrl} (${response.status})`);
      return '';
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) {
      console.log(`CHOIVE fetchWebsite: non-HTML content for ${safeUrl} (${contentType})`);
      return '';
    }

    const html = await response.text();
    return extractText(html);
  } catch (error) {
    clearTimeout(timeout);

    if (error.name === 'AbortError') {
      console.log(`CHOIVE fetchWebsite: timed out for ${safeUrl}`);
    } else {
      console.log(`CHOIVE fetchWebsite: error for ${safeUrl}: ${error.message}`);
    }

    return '';
  }
}

module.exports = {
  fetchWebsiteText,
  ensureProtocol,
  extractText
};
