// lib/locale.js
// CHOIVE™ — Multi-language locale detection and query translation
// Detects business language from city/country and returns localised query variants
// Supports: English, Spanish, French, German, Portuguese, Italian,
//           Arabic, Dutch, Polish, Japanese

const CITY_TO_LOCALE = {
  // Spanish
  'madrid': 'es', 'barcelona': 'es', 'seville': 'es', 'valencia': 'es',
  'mexico city': 'es', 'cdmx': 'es', 'bogota': 'es', 'lima': 'es',
  'buenos aires': 'es', 'santiago': 'es', 'miami': 'es',
  // French
  'paris': 'fr', 'lyon': 'fr', 'marseille': 'fr', 'toulouse': 'fr',
  'montreal': 'fr', 'brussels': 'fr', 'geneva': 'fr', 'lausanne': 'fr',
  // German
  'berlin': 'de', 'munich': 'de', 'hamburg': 'de', 'frankfurt': 'de',
  'cologne': 'de', 'dusseldorf': 'de', 'vienna': 'de', 'zurich': 'de',
  'berne': 'de', 'stuttgart': 'de', 'boblingen': 'de', 'böblingen': 'de',
  // Portuguese
  'lisbon': 'pt', 'porto': 'pt', 'sao paulo': 'pt', 'rio de janeiro': 'pt',
  'brasilia': 'pt', 'salvador': 'pt',
  // Italian
  'rome': 'it', 'milan': 'it', 'naples': 'it', 'turin': 'it', 'florence': 'it',
  // Arabic
  'dubai': 'ar', 'abu dhabi': 'ar', 'riyadh': 'ar', 'cairo': 'ar',
  'doha': 'ar', 'kuwait city': 'ar', 'beirut': 'ar', 'casablanca': 'ar',
  'amman': 'ar', 'muscat': 'ar',
  // Dutch
  'amsterdam': 'nl', 'rotterdam': 'nl', 'the hague': 'nl', 'utrecht': 'nl',
  // Polish
  'warsaw': 'pl', 'krakow': 'pl', 'wroclaw': 'pl', 'gdansk': 'pl',
  // Japanese
  'tokyo': 'ja', 'osaka': 'ja', 'kyoto': 'ja', 'yokohama': 'ja',
};

const LOCALE_TEMPLATES = {
  en: {
    best:          function(cat, loc) { return 'best ' + cat + (loc ? ' in ' + loc : ''); },
    top:           function(cat, loc) { return 'top ' + cat + (loc ? ' in ' + loc : ''); },
    recommend:     function(cat, loc) { return 'recommended ' + cat + (loc ? ' for ' + loc : ''); },
    compare:       function(cat)      { return cat + ' comparison'; },
    alternatives:  function(cat)      { return cat + ' alternatives'; }
  },
  es: {
    best:          function(cat, loc) { return 'mejor ' + cat + (loc ? ' en ' + loc : ''); },
    top:           function(cat, loc) { return 'mejores ' + cat + (loc ? ' en ' + loc : ''); },
    recommend:     function(cat, loc) { return cat + ' recomendado' + (loc ? ' en ' + loc : ''); },
    compare:       function(cat)      { return 'comparativa ' + cat; },
    alternatives:  function(cat)      { return 'alternativas a ' + cat; }
  },
  fr: {
    best:          function(cat, loc) { return 'meilleur ' + cat + (loc ? ' à ' + loc : ''); },
    top:           function(cat, loc) { return 'top ' + cat + (loc ? ' à ' + loc : ''); },
    recommend:     function(cat, loc) { return cat + ' recommandé' + (loc ? ' à ' + loc : ''); },
    compare:       function(cat)      { return 'comparatif ' + cat; },
    alternatives:  function(cat)      { return 'alternatives ' + cat; }
  },
  de: {
    best:          function(cat, loc) { return 'bester ' + cat + (loc ? ' in ' + loc : ''); },
    top:           function(cat, loc) { return 'top ' + cat + (loc ? ' in ' + loc : ''); },
    recommend:     function(cat, loc) { return cat + ' empfehlung' + (loc ? ' ' + loc : ''); },
    compare:       function(cat)      { return cat + ' vergleich'; },
    alternatives:  function(cat)      { return cat + ' alternativen'; }
  },
  pt: {
    best:          function(cat, loc) { return 'melhor ' + cat + (loc ? ' em ' + loc : ''); },
    top:           function(cat, loc) { return 'melhores ' + cat + (loc ? ' em ' + loc : ''); },
    recommend:     function(cat, loc) { return cat + ' recomendado' + (loc ? ' em ' + loc : ''); },
    compare:       function(cat)      { return 'comparação ' + cat; },
    alternatives:  function(cat)      { return 'alternativas ' + cat; }
  },
  it: {
    best:          function(cat, loc) { return 'migliore ' + cat + (loc ? ' a ' + loc : ''); },
    top:           function(cat, loc) { return 'top ' + cat + (loc ? ' a ' + loc : ''); },
    recommend:     function(cat, loc) { return cat + ' consigliato' + (loc ? ' a ' + loc : ''); },
    compare:       function(cat)      { return 'confronto ' + cat; },
    alternatives:  function(cat)      { return 'alternative ' + cat; }
  },
  ar: {
    best:          function(cat, loc) { return 'أفضل ' + cat + (loc ? ' في ' + loc : ''); },
    top:           function(cat, loc) { return 'أفضل ' + cat + (loc ? ' في ' + loc : ''); },
    recommend:     function(cat, loc) { return cat + ' موصى به' + (loc ? ' في ' + loc : ''); },
    compare:       function(cat)      { return 'مقارنة ' + cat; },
    alternatives:  function(cat)      { return 'بدائل ' + cat; }
  },
  nl: {
    best:          function(cat, loc) { return 'beste ' + cat + (loc ? ' in ' + loc : ''); },
    top:           function(cat, loc) { return 'top ' + cat + (loc ? ' in ' + loc : ''); },
    recommend:     function(cat, loc) { return 'aanbevolen ' + cat + (loc ? ' in ' + loc : ''); },
    compare:       function(cat)      { return cat + ' vergelijking'; },
    alternatives:  function(cat)      { return cat + ' alternatieven'; }
  },
  pl: {
    best:          function(cat, loc) { return 'najlepszy ' + cat + (loc ? ' w ' + loc : ''); },
    top:           function(cat, loc) { return 'top ' + cat + (loc ? ' w ' + loc : ''); },
    recommend:     function(cat, loc) { return 'polecany ' + cat + (loc ? ' w ' + loc : ''); },
    compare:       function(cat)      { return 'porównanie ' + cat; },
    alternatives:  function(cat)      { return 'alternatywy ' + cat; }
  },
  ja: {
    best:          function(cat, loc) { return (loc ? loc + 'の' : '') + '最高の' + cat; },
    top:           function(cat, loc) { return (loc ? loc + 'の' : '') + 'おすすめ' + cat; },
    recommend:     function(cat, loc) { return cat + 'おすすめ' + (loc ? loc : ''); },
    compare:       function(cat)      { return cat + '比較'; },
    alternatives:  function(cat)      { return cat + '代替'; }
  }
};

/**
 * Detect locale from city string
 * Falls back to 'en' if not found
 */
function detectLocale(city) {
  if (!city) return 'en';
  var cityLower = city.toLowerCase().trim();
  // Try exact match first
  if (CITY_TO_LOCALE[cityLower]) return CITY_TO_LOCALE[cityLower];
  // Try partial match
  var keys = Object.keys(CITY_TO_LOCALE);
  for (var i = 0; i < keys.length; i++) {
    if (cityLower.includes(keys[i]) || keys[i].includes(cityLower)) {
      return CITY_TO_LOCALE[keys[i]];
    }
  }
  return 'en';
}

/**
 * Build localised search queries for the given category and city
 * Returns both English queries (always) plus local-language variants
 */
function buildLocalisedQueries(category, city, locale) {
  var templates = LOCALE_TEMPLATES[locale] || LOCALE_TEMPLATES['en'];
  var enTemplates = LOCALE_TEMPLATES['en'];

  var queries = [
    // Always include English (global AI training data is primarily English)
    { q: enTemplates.best(category, city),         type: 'comparison', lang: 'en' },
    { q: enTemplates.top(category, city),           type: 'comparison', lang: 'en' },
    { q: enTemplates.alternatives(category),        type: 'comparison', lang: 'en' },
  ];

  // Add local-language variants if not English
  if (locale !== 'en') {
    queries.push({ q: templates.best(category, city),        type: 'comparison', lang: locale });
    queries.push({ q: templates.top(category, city),         type: 'comparison', lang: locale });
    queries.push({ q: templates.recommend(category, city),   type: 'comparison', lang: locale });
    queries.push({ q: templates.compare(category),           type: 'comparison', lang: locale });
    queries.push({ q: templates.alternatives(category),      type: 'comparison', lang: locale });
  }

  return queries;
}

/**
 * Build localised AI simulation queries
 * Returns prompts in both English and local language
 */
function buildLocalisedAIQueries(category, city, name, locale) {
  var templates = LOCALE_TEMPLATES[locale] || LOCALE_TEMPLATES['en'];
  var enT = LOCALE_TEMPLATES['en'];
  var loc = city || '';

  var queries = [
    {
      label:  'Discovery (English)',
      system: 'You are a helpful AI assistant. Name real companies. Be specific.',
      query:  'What are the best ' + category + (loc ? ' options in ' + loc : '') + '? Give me 3-5 recommendations.'
    },
    {
      label:  'Direct recommendation (English)',
      system: 'You are a helpful AI assistant. Name real companies. Be specific.',
      query:  'Which ' + category + ' would you recommend' + (loc ? ' for ' + loc : '') + '? Top pick and why.'
    }
  ];

  if (locale !== 'en') {
    queries.push({
      label:  'Discovery (' + locale.toUpperCase() + ')',
      system: 'You are a helpful AI assistant. Name real companies. Be specific.',
      query:  templates.best(category, city) + '? ' + (locale === 'es' ? 'Dame 3-5 recomendaciones.' : locale === 'fr' ? 'Donne-moi 3-5 recommandations.' : locale === 'de' ? 'Gib mir 3-5 Empfehlungen.' : '3-5 recommendations.')
    });
    queries.push({
      label:  'Recommendation (' + locale.toUpperCase() + ')',
      system: 'You are a helpful AI assistant. Name real companies. Be specific.',
      query:  templates.recommend(category, city) + '?'
    });
  }

  return queries;
}

module.exports = {
  detectLocale,
  buildLocalisedQueries,
  buildLocalisedAIQueries,
  SUPPORTED_LOCALES: Object.keys(LOCALE_TEMPLATES)
};
