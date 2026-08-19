'use strict';

// seo-keywords.js
// A plain-language "what your buyers actually ask" keyword map for the premium
// report.
//
// STRICT HONESTY: search tools like ours do NOT give real monthly search
// volumes, so we NEVER show a made-up "1,300 searches/month" number. Instead we
// give the owner the exact PHRASES real buyers type when they want a business
// like theirs — the same phrase patterns CHOIVE's own engine searches to test
// AI answers. These are grounded in the business's real category, its real
// location, and the real rival names we recorded. No invented facts.
//
// Every phrase is built from data we already have. If we have no category, we
// cannot build honest phrases, so we say so.

function clean(s, max) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max).trim();
  return t;
}

// Trim a long inferred category down to a short, searchable phrase.
// e.g. "B2B OTT middleware platform for telcos" -> "OTT middleware platform"
function shortCategory(category) {
  var c = clean(category, 120)
    .replace(/^b2b\s+/i, '')
    .replace(/^b2c\s+/i, '')
    .replace(/\s+for\s+.+$/i, '')
    .trim();
  var words = c.split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join(' ');
}

function dedupe(arr) {
  var seen = {};
  return arr.filter(function (p) {
    var k = p.toLowerCase();
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

/**
 * buildKeywordStrategy(result, input) -> {
 *   available: boolean,
 *   category: string,
 *   groups: [ { key, title, why, phrases: [string] } ],
 *   howToUse: string
 * }
 *
 * `input` is the saved diagnostic input ({ name, category, city, ... }) so we
 * can ground phrases in the real business name and location. Both args optional.
 */
function buildKeywordStrategy(result, input) {
  var r = result && typeof result === 'object' ? result : {};
  var inp = input && typeof input === 'object' ? input : {};

  var rawCategory = r.inferredCategory || inp.category || '';
  var cat = shortCategory(rawCategory);
  if (!cat) {
    return { available: false, reason: 'We need your business category before we can show the phrases buyers type.' };
  }

  var name = clean(inp.name || '', 60);
  var city = clean(inp.city || '', 60);
  var place = city ? (' ' + city) : '';

  // Real rival names we recorded — used to build honest "you vs them" phrases.
  var rivals = [];
  if (r.displacement && r.displacement.competitorName) rivals.push(clean(r.displacement.competitorName, 40));
  (Array.isArray(r.competitors) ? r.competitors : []).forEach(function (c) {
    if (c && c.domain) {
      var brand = clean(String(c.domain).split('.')[0], 30);
      if (brand && brand.length >= 3) rivals.push(brand);
    }
  });
  rivals = dedupe(rivals).slice(0, 3);

  var groups = [];

  // 1. "Ready to buy" — highest intent, buyers looking for exactly this.
  var buyNow = dedupe([
    'best ' + cat + place,
    'top ' + cat + place,
    cat + ' near me',
    (city ? cat + ' in ' + city : cat + ' online')
  ]);
  groups.push({
    key: 'ready',
    title: 'People ready to buy',
    why: 'These are the phrases people type when they are ready to pick someone. Make sure AI can answer them with your name.',
    phrases: buyNow
  });

  // 2. "Checking you out" — buyers looking up the business by name.
  if (name) {
    groups.push({
      key: 'yourname',
      title: 'People checking you out',
      why: 'People already heard of you and want to know if you are any good. AI must have a clear, trusted answer.',
      phrases: dedupe([
        name + ' reviews',
        'is ' + name + ' good',
        name + ' ' + cat
      ])
    });
  }

  // 3. "Comparing you" — only when we recorded real rivals.
  if (rivals.length) {
    var vs = [];
    rivals.forEach(function (rv) {
      if (name) vs.push(name + ' vs ' + rv);
      vs.push('best ' + cat + ' like ' + rv);
    });
    groups.push({
      key: 'comparing',
      title: 'People comparing options',
      why: 'These buyers are weighing you against others AI already knows. Give AI a clear reason to pick you.',
      phrases: dedupe(vs).slice(0, 5)
    });
  }

  // 4. "Just learning" — top-of-funnel questions about the category.
  groups.push({
    key: 'learning',
    title: 'People just learning',
    why: 'These buyers are early and asking questions. Answer them well and AI starts trusting you as the helpful expert.',
    phrases: dedupe([
      'how to choose ' + cat,
      'what is the best ' + cat,
      cat + ' tips'
    ])
  });

  return {
    available: true,
    category: cat,
    groups: groups,
    howToUse: 'These are the real phrases buyers type into Google and AI assistants for a business like yours. You do not need to guess search numbers. Just make sure your website and profiles clearly answer these exact questions — then AI can repeat your answer instead of a rival\u2019s.'
  };
}

module.exports = { buildKeywordStrategy: buildKeywordStrategy };
