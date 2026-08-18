// website-identity.js
// CHOIVE — Confirms a fetched web page actually belongs to the business.
//
// When we fetch a website for a business, we sometimes land on the wrong page:
// a parked domain, a squatter, a look-alike, or a totally different company that
// happens to sit on the URL the user typed. Before we trust that page's words as
// evidence about the business, we do a quick sanity check: does the page's title
// and main heading actually mention this business?
//
// websiteIdentityMatches(name, website, inferredSite, pageText) -> boolean
//   name         : the business name the user gave us (e.g. "Nike Sportswear")
//   website      : the URL the user typed (may be blank)
//   inferredSite : the official site we guessed from search results (may be blank)
//   pageText     : the page's title text + main heading text, joined together
//
// Returns true when the page looks like it belongs to the business, false when
// it clearly does not. When we cannot tell (blank name, blank page), we return
// true so we do NOT throw away a page for no reason.

var normalizeUrl;
try {
  // Reuse the same URL cleaner the rest of the engine uses, so a domain here is
  // cleaned the exact same way as everywhere else.
  normalizeUrl = require('./serper').normalizeUrl;
} catch (e) {
  normalizeUrl = null;
}

// Fallback URL cleaner — only used if serper's is unavailable for any reason.
function cleanUrl(url) {
  if (typeof normalizeUrl === 'function') return normalizeUrl(url);
  if (!url) return '';
  try {
    var u = new URL(String(url).startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return String(url).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}

// Words that carry no identity on their own — company suffixes and filler.
// We drop these so "Acme Inc" and "Acme" are treated the same.
var STOP_WORDS = {
  'inc': 1, 'incorporated': 1, 'llc': 1, 'ltd': 1, 'limited': 1, 'co': 1,
  'corp': 1, 'corporation': 1, 'company': 1, 'group': 1, 'holdings': 1,
  'plc': 1, 'gmbh': 1, 'sa': 1, 'srl': 1, 'bv': 1, 'ag': 1, 'pty': 1,
  'the': 1, 'and': 1, 'of': 1, 'for': 1, 'a': 1, 'an': 1
};

// Turn any text into a clean list of lowercase word tokens.
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // keep letters + numbers, drop punctuation
    .split(/\s+/)
    .filter(Boolean);
}

// The tokens from a business name that actually carry its identity.
function identityTokens(name) {
  return tokenize(name).filter(function (t) {
    return t.length >= 2 && !STOP_WORDS[t];
  });
}

// Squash text to just letters+numbers, no spaces — for "does the whole name
// appear glued together" checks (handles "AcmeCorp" vs "Acme Corp").
function squash(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function websiteIdentityMatches(name, website, inferredSite, pageText) {
  var nameTokens = identityTokens(name);

  // Can't judge without a real name or any page text — don't throw the page away.
  if (nameTokens.length === 0) return true;
  var page = String(pageText || '').trim();
  if (!page) return true;

  var pageTokens = tokenize(page);
  if (pageTokens.length === 0) return true;

  var pageTokenSet = {};
  for (var i = 0; i < pageTokens.length; i++) pageTokenSet[pageTokens[i]] = 1;

  // 1) Whole name appears glued together in the page (strongest signal).
  //    e.g. name "Acme Corp" -> "acmecorp" found inside the squashed page text.
  var nameSquashed = squash(name);
  var pageSquashed = squash(page);
  if (nameSquashed.length >= 4 && pageSquashed.indexOf(nameSquashed) !== -1) {
    return true;
  }

  // 2) The business domain's core word shows up in the page.
  //    e.g. website "acme.com" -> "acme" appears in the title/heading.
  var domain = cleanUrl(website) || cleanUrl(inferredSite);
  if (domain) {
    var domainCore = domain.split('.')[0]; // "acme" from "acme.com"
    if (domainCore && domainCore.length >= 3 && pageSquashed.indexOf(domainCore) !== -1) {
      return true;
    }
  }

  // 3) Enough of the name's identity words appear in the page.
  //    We need at least half of them (rounded up), so a one-word name needs
  //    that one word, a two-word name needs at least one, etc.
  var hits = 0;
  for (var j = 0; j < nameTokens.length; j++) {
    if (pageTokenSet[nameTokens[j]]) hits++;
  }
  var needed = Math.ceil(nameTokens.length / 2);
  if (hits >= needed) return true;

  // 4) A single, long, distinctive name word appearing is good enough.
  //    e.g. name "Patagonia Outdoor Wear" and page mentions "patagonia".
  for (var k = 0; k < nameTokens.length; k++) {
    if (nameTokens[k].length >= 6 && pageTokenSet[nameTokens[k]]) return true;
  }

  // Nothing matched — the page probably is NOT this business.
  return false;
}

module.exports = { websiteIdentityMatches: websiteIdentityMatches };
