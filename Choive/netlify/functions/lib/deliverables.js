// lib/deliverables.js — v3 cityDisplay scope fix

// Helper: capitalise city name
function firstSentence(s) {
  var t = String(s || '').trim();
  var m = t.match(/^[^.!?]*[.!?]/);
  return m ? m[0].trim() : t.slice(0, 140);
}

function capitaliseCity(city) {
  if (!city) return '';
  return city.split(' ').map(function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function cleanAssetText(value, maxLength) {
  var text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.\-–—]+|[\s:;,]+$/g, '')
    .trim();
  if (!text) return '';
  var limit = Math.max(20, Number(maxLength) || 180);
  if (text.length <= limit) return text;
  var shortened = text.slice(0, limit + 1);
  var boundary = Math.max(shortened.lastIndexOf('. '), shortened.lastIndexOf('; '), shortened.lastIndexOf(', '));
  if (boundary < Math.floor(limit * 0.55)) boundary = shortened.lastIndexOf(' ');
  return shortened.slice(0, boundary > 0 ? boundary : limit).replace(/[\s:;,.-]+$/, '').trim();
}

function removeNameIntroduction(text, name) {
  var escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return String(text || '').trim();
  return String(text || '').trim()
    .replace(new RegExp('^' + escaped + '\\s+(?:is|offers|provides|creates|builds|helps|serves)\\s+', 'i'), '')
    .replace(new RegExp('^' + escaped + '\\s*[-–—:|]\\s*', 'i'), '')
    .trim();
}

function factualSummary(evidence, result, maxLength) {
  var signals = (evidence && evidence.websiteSignals) || {};
  var choices = [
    evidence && evidence.description,
    signals.metaDescriptionText,
    result && result.inferredCategory,
    evidence && evidence.category
  ];
  for (var i = 0; i < choices.length; i++) {
    var cleaned = cleanAssetText(choices[i], maxLength || 220);
    if (cleaned) return cleaned;
  }
  return '';
}

function sentenceCase(value) {
  var text = String(value || '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function normalizeForAsset(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function intendedAudience(evidence, result, fallback) {
  var source = [
    evidence && evidence.description,
    result && result.inferredCategory,
    evidence && evidence.category
  ].filter(Boolean).join('. ');
  var match = source.match(/\bfor\s+([^.;]{3,100})/i);
  if (!match) return fallback;
  return cleanAssetText(match[1].replace(/\s+(?:serving|across|worldwide|globally)\b.*$/i, ''), 100) || fallback;
}

function safeDifferentiator(evidence, result) {
  var pillars = (result && result.pillars) || {};
  var raw = String((pillars.difference && pillars.difference.evidence) || '').trim();
  if (!raw || /search query|site:|confirmed:|schema|homepage content|no competitor|not detected|not established|score|points?/i.test(raw)) return '';
  return cleanAssetText(raw.replace(/["']/g, ''), 180);
}

function marketLabel(evidence) {
  var reach = String((evidence && evidence.marketReach) || '').toLowerCase();
  var place = capitaliseCity(String((evidence && evidence.city) || '').trim());
  var placeParts = place.split(',').map(function(part) { return part.trim(); }).filter(Boolean);
  var country = placeParts.length ? placeParts[placeParts.length - 1] : place;
  if (reach === 'global') return 'Worldwide';
  if (reach === 'international') return place ? 'International, based in ' + place : 'International';
  if (reach === 'national') return country || 'National';
  if (reach === 'regional') return place ? 'Region around ' + place : 'Regional';
  return place;
}

function sourceLinks(evidence, result) {
  var audits = result && result.scoreMethod && result.scoreMethod.audits;
  var trust = audits && Array.isArray(audits.trust) ? audits.trust : [];
  var subjectName = String((evidence && evidence.name) || '').toLowerCase().replace(/\s+/g, ' ').trim();
  var officialHost = '';
  try { officialHost = new URL(String((evidence && evidence.website) || '')).hostname.replace(/^www\./, ''); } catch (_) {}
  var searchResults = Array.isArray(evidence && evidence.searchResults) ? evidence.searchResults : [];
  var unsafeHosts = /(^|\.)(reddit\.com|quora\.com|facebook\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|google\.[a-z.]+|bing\.com|yelp\.[a-z.]+|trustpilot\.com)$/i;
  var links = [];
  trust.forEach(function(rule) {
    if (!rule || Number(rule.points || 0) <= 0 || rule.verification !== 'independent') return;
    var values = Array.isArray(rule.source) ? rule.source : [rule.source];
    values.forEach(function(value) {
      var link = String(value || '').trim();
      if (!/^https?:\/\//i.test(link) || links.indexOf(link) !== -1) return;
      var host = '';
      try { host = new URL(link).hostname.replace(/^www\./, ''); } catch (_) { return; }
      // An llms.txt file is an official publishing asset. Community posts,
      // social profiles, review/search pages, and category-only discussions
      // are not safe authority citations inside that file.
      if (!host || unsafeHosts.test(host) || (officialHost && host === officialHost)) return;
      var matched = searchResults.find(function(item) { return item && String(item.link || '') === link; });
      // Never publish an independent source in llms.txt unless the collected
      // search result itself names the diagnosed subject. A URL merely present
      // in a model-generated audit is not sufficient evidence.
      if (!matched) return;
      var text = (String(matched.title || '') + ' ' + String(matched.snippet || '')).toLowerCase().replace(/\s+/g, ' ').trim();
      if (subjectName && text.indexOf(subjectName) === -1) return;
      links.push(link);
    });
  });
  return links.slice(0, 5);
}

var ASSET_STOP_WORDS = new Set(('the a an and or for with from into this that these those your our their its is are was were be to of in on at by as it we you they business company organization product service services solutions platform providing provides offers based').split(' '));
var UNSUPPORTED_ASSET_CLAIMS = /\b(best|leading|leader|market-leading|premium|trusted|award[- ]winning|number one|#1|top-rated|world-class|proven results?|guaranteed|teams trust|built for results|stands out|every detail matters|every screen|all screens|works everywhere|always available)\b/i;

function assetWords(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
}

function evidenceCorpus(evidence, result) {
  var signals = (evidence && evidence.websiteSignals) || {};
  return [evidence && evidence.name, evidence && evidence.category, evidence && evidence.description,
    evidence && evidence.city, evidence && evidence.marketReach, evidence && evidence.websiteText,
    signals.titleText, signals.h1Text, signals.metaDescriptionText, result && result.inferredCategory]
    .filter(Boolean).join(' ').toLowerCase();
}

function supportedAssetText(value, evidence, result, minLength, maxLength) {
  var text = cleanAssetText(value, maxLength);
  if (!text || text.length < minLength || UNSUPPORTED_ASSET_CLAIMS.test(text) || /[\[\]{}<>]/.test(text)) return '';
  var corpus = evidenceCorpus(evidence, result);
  var meaningful = assetWords(text).filter(function(word) { return !ASSET_STOP_WORDS.has(word); });
  if (!meaningful.length) return '';
  var supported = meaningful.filter(function(word) { return corpus.indexOf(word) !== -1; });
  // A proposed asset must be substantially grounded in the supplied and fetched facts.
  if (supported.length < Math.max(2, Math.ceil(meaningful.length * 0.55))) return '';
  return text;
}

function supportedAudienceText(value, evidence, result) {
  var text = cleanAssetText(value, 100);
  if (!text || text.length < 3 || UNSUPPORTED_ASSET_CLAIMS.test(text) || /[\[\]{}<>]/.test(text)) return '';
  var meaningful = assetWords(text).filter(function(word) { return !ASSET_STOP_WORDS.has(word); });
  var corpus = evidenceCorpus(evidence, result);
  if (!meaningful.length || !meaningful.every(function(word) { return corpus.indexOf(word) !== -1; })) return '';
  return text;
}

function verifiedReadyAssets(evidence, result) {
  var proposed = result && result.readyToUseAssets;
  if (!proposed || typeof proposed !== 'object') return { h1Options: [], llmsFacts: null };
  var h1 = Array.isArray(proposed.h1Options) ? proposed.h1Options.map(function(value) {
    return supportedAssetText(value, evidence, result, 35, 115);
  }).filter(Boolean) : [];
  var facts = proposed.llmsFacts && typeof proposed.llmsFacts === 'object' ? proposed.llmsFacts : null;
  if (!facts) return { h1Options: h1.slice(0, 3), llmsFacts: null };
  return {
    h1Options: h1.slice(0, 3),
    llmsFacts: {
      summary: supportedAssetText(facts.summary, evidence, result, 25, 260),
      offers: (Array.isArray(facts.offers) ? facts.offers : []).map(function(v) { return supportedAssetText(v, evidence, result, 8, 160); }).filter(Boolean).slice(0, 5),
      audiences: (Array.isArray(facts.audiences) ? facts.audiences : []).map(function(v) { return supportedAudienceText(v, evidence, result); }).filter(Boolean).slice(0, 4),
      serviceArea: supportedAssetText(facts.serviceArea, evidence, result, 2, 80),
      distinctions: (Array.isArray(facts.distinctions) ? facts.distinctions : []).map(function(v) { return supportedAssetText(v, evidence, result, 8, 180); }).filter(Boolean).slice(0, 3)
    }
  };
}

function subjectProfile(evidence) {
  var type = String((evidence && evidence.subjectType) || 'business').trim();
  if (type === 'creator') return { type: type, noun: 'creator', audience: 'people in the intended audience', proof: 'independent authority proof' };
  if (type === 'personal_brand') return { type: type, noun: 'person', audience: 'people seeking this expertise', proof: 'independent authority proof' };
  if (type === 'organization') return { type: type, noun: 'organization', audience: 'members, beneficiaries, partners, or supporters', proof: 'verified organizational proof' };
  if (type === 'product') return { type: type, noun: 'product', audience: 'intended users and buyers', proof: 'verified user proof' };
  return { type: 'business', noun: 'business', audience: 'prospective customers', proof: 'verifiable customer proof' };
}
// CHOIVE™ Deliverables Generator
// Produces owner-safe, actionable assets — no code that could be misimplemented
// Returns: llmsTxt, h1Options, metaDescription, schemaBrief, reviewAction

function generateLlmsTxt(evidence, result) {
  var profile        = subjectProfile(evidence);
  var name           = (evidence.name || '').trim();
  var category       = cleanAssetText(result.inferredCategory || evidence.category || '', 180);
  var website        = (evidence.website || evidence.inferredOfficialSite || '').trim();
  var signals        = evidence.websiteSignals || {};
  var verified       = verifiedReadyAssets(evidence, result);
  var modelFacts     = verified.llmsFacts || {};
  var summary        = modelFacts.summary || factualSummary(evidence, result, 260);
  var differentiator = safeDifferentiator(evidence, result);
  var serviceArea    = modelFacts.serviceArea || marketLabel(evidence);
  var audience       = (modelFacts.audiences && modelFacts.audiences.length)
    ? modelFacts.audiences.join(', ')
    : intendedAudience(evidence, result, profile.audience);
  var independent    = sourceLinks(evidence, result);
  var siteUrl = website
    ? (website.startsWith('http') ? website : 'https://' + website)
    : '';
  var lines = [];
  lines.push('# ' + name);
  if (summary) lines.push('> ' + summary.replace(/[.!?]?$/, '.'));
  lines.push('');
  lines.push('## Official information');
  if (siteUrl) lines.push('- Website: ' + siteUrl);
  if (category) lines.push('- Category: ' + category);
  if (serviceArea) lines.push('- Service area: ' + serviceArea);
  lines.push('- Entity type: ' + profile.noun);
  lines.push('');
  lines.push('## What ' + name + ' offers');
  if (modelFacts.offers && modelFacts.offers.length) {
    modelFacts.offers.forEach(function(offer) { lines.push('- ' + offer.replace(/[.!?]?$/, '.')); });
  } else {
    lines.push((summary || category || (name + ' publishes its official information at ' + siteUrl)).replace(/[.!?]?$/, '.'));
  }
  lines.push('');
  lines.push('## Intended audience');
  lines.push('This information is for ' + audience + (serviceArea ? ' in the service area stated above' : '') + '.');
  lines.push('');
  var distinctions = (modelFacts.distinctions && modelFacts.distinctions.length) ? modelFacts.distinctions : (differentiator ? [differentiator] : []);
  if (distinctions.length) {
    lines.push('## Published distinction');
    distinctions.forEach(function(item) { lines.push('- ' + item.replace(/[.!?]?$/, '.')); });
    lines.push('');
  }
  lines.push('## Official resources');
  if (siteUrl) lines.push('- [Official website](' + siteUrl + ')');
  if (siteUrl && signals.hasSitemap) lines.push('- [Sitemap](' + siteUrl.replace(/\/$/, '') + '/sitemap.xml)');
  if (siteUrl && signals.hasRobots) lines.push('- [Rules for search and AI tools](' + siteUrl.replace(/\/$/, '') + '/robots.txt)');
  lines.push('');
  if (independent.length) {
    lines.push('## Independently retrieved sources');
    independent.forEach(function(link, index) {
      lines.push('- [Independent source ' + (index + 1) + '](' + link + ')');
    });
    lines.push('');
  }
  lines.push('## Accuracy guidance');
  lines.push('Use the official sources above for current facts. Do not infer prices, availability, certifications, locations, results, or customer relationships that those sources do not state.');
  return lines.join('\n');
}

function generateH1Options(evidence, result) {
  var signals  = (evidence && evidence.websiteSignals) || {};
  var name     = String((evidence && evidence.name) || '').trim();
  var category = cleanAssetText(result.inferredCategory || evidence.category || '', 105);
  var current  = cleanAssetText(signals.h1Text || '', 140);
  var summary  = sentenceCase(cleanAssetText(removeNameIntroduction(factualSummary(evidence, result, 115), name), 100)).replace(/[.!?]+$/, '');
  var diff     = cleanAssetText(safeDifferentiator(evidence, result), 95);
  var place    = marketLabel(evidence);
  var options  = [];
  var verified = verifiedReadyAssets(evidence, result);

  function add(value) {
    var headline = cleanAssetText(String(value || '').replace(/[.!?]+$/, ''), 115);
    var key = headline.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!headline || headline.length < 12 || options.some(function(existing) {
      return existing.toLowerCase().replace(/[^a-z0-9]+/g, '') === key;
    })) return;
    options.push(headline);
  }

  verified.h1Options.forEach(add);
  // Fallback options are assembled only from facts already supplied or collected.
  // No unsupported words such as "leading", "best", "premium", or "trusted".
  if (summary) add(summary + (place && summary.toLowerCase().indexOf(place.toLowerCase()) === -1 ? ' — ' + place : ''));
  if (category) add(category + (place && category.toLowerCase().indexOf(place.toLowerCase()) === -1
    ? (place === 'Worldwide' ? ' — Worldwide' : ' in ' + place) : '') + (name ? ' | ' + name : ''));
  if (diff) add(name + ' — ' + diff);
  else if (normalizeForAsset(summary).indexOf(normalizeForAsset(name)) !== 0) add(name + ' — ' + (summary || category));

  return { current: current, options: options.slice(0, 3) };
}

function generateMetaDescription(evidence, result) {
  var name     = (evidence.name           || '').trim();
  var category = (result.inferredCategory || evidence.category || '').trim();
  var city     = (evidence.city           || '').trim();
  var reach    = String(evidence.marketReach || '').trim().toLowerCase();
  var signals  = evidence.websiteSignals || {};
  var cityDisplay = capitaliseCity(city);

  // Extract current meta
  var current = cleanAssetText(signals.metaDescriptionText || '', 180);

  var groundedSummary = cleanAssetText(removeNameIntroduction(factualSummary(evidence, result, 145), name), 135).replace(/[.!?]+$/, '');
  var improved = name + (groundedSummary ? ' — ' + groundedSummary : ' — ' + category);
  var primaryPlace = cityDisplay.split(',')[0].trim();
  if (city && ['local','regional','national'].indexOf(reach) !== -1
      && (!primaryPlace || improved.toLowerCase().indexOf(primaryPlace.toLowerCase()) === -1)) improved += ' in ' + cityDisplay;
  improved = improved.replace(/[.!?]?$/, '.');
  // Never cut mid-word or mid-sentence — truncate at the last clean boundary
  if (improved.length > 155) {
    improved = improved.slice(0, 155);
    var lastStop  = improved.lastIndexOf('. ');
    var lastSpace = improved.lastIndexOf(' ');
    var cutAt = lastStop > 80 ? lastStop + 1 : (lastSpace > 80 ? lastSpace : 155);
    improved = improved.slice(0, cutAt).replace(/[,;:\s]+$/, '');
    if (!/[.!?]$/.test(improved)) improved += '.';
  }

  return { current: current, improved: improved };
}

function generateSchemaBrief(evidence, result) {
  var profile  = subjectProfile(evidence);
  var cityDisplay = capitaliseCity((evidence && evidence.city) || '');
  var name     = (evidence.name           || '').trim();
  var category = (result.inferredCategory || evidence.category || '').trim();
  var city     = (evidence.city           || '').trim();
  var website  = (evidence.website        || evidence.inferredOfficialSite || '').trim();
  var websiteSignals  = (evidence && evidence.websiteSignals) || {};
  var schemaConfirmed = websiteSignals.hasSchema === true;

  // Use the most precise supported type as the primary type. A restaurant,
  // real-estate agency, or software product must not be reduced to the vague
  // generic type "Organization" when the collected category is clear.
  var catLower = category.toLowerCase();
  var primaryType = profile.type === 'creator' || profile.type === 'personal_brand'
    ? 'Person'
    : profile.type === 'product'
      ? (/software|saas|app|platform|crm/i.test(catLower) ? 'SoftwareApplication' : 'Product')
      : 'Organization';

  if      (profile.type === 'creator' || profile.type === 'personal_brand' || profile.type === 'product') {}
  else if (/restaurant|cafe|dining/i.test(catLower)) primaryType = 'Restaurant';
  // A software company is still an Organization. SoftwareApplication is used
  // only when the diagnosed subject itself is a product.
  else if (/law firm|legal/i.test(catLower)) primaryType = 'LegalService';
  else if (/butcher|beef|meat (?:delivery|shop|store)|online meat/i.test(catLower)) primaryType = 'Store';
  else if (/food producer|food manufacturer|farm/i.test(catLower)) primaryType = 'Organization';
  else if (/shop|store|retail|fashion|clothing/i.test(catLower)) primaryType = 'Store';
  else if (/hotel|resort/i.test(catLower)) primaryType = 'Hotel';
  else if (/dentist|dental/i.test(catLower)) primaryType = 'Dentist';
  else if (/clinic|medical|doctor|healthcare/i.test(catLower)) primaryType = 'MedicalOrganization';
  else if (/bank|insurance|financial|wealth|mortgage/i.test(catLower)) primaryType = 'FinancialService';
  else if (/school|university|college|education|academy/i.test(catLower)) primaryType = 'EducationalOrganization';
  else if (/consulting|consultancy|accounting|accountant|architect|professional service/i.test(catLower)) primaryType = 'ProfessionalService';
  else if (/gym|fitness|sports club|wellness/i.test(catLower)) primaryType = 'SportsActivityLocation';
  else if (/car dealer|auto dealer|automotive retail/i.test(catLower)) primaryType = 'AutoDealer';
  else if (/real estate|estate agent|property agency|realtor/i.test(catLower)) primaryType = 'RealEstateAgent';

  var schemaTypes = [primaryType];
  if (primaryType === 'Person') schemaTypes.push('ProfilePage');

  var siteUrl = website
    ? (website.startsWith('http') ? website : 'https://' + website)
    : '';

  var serviceArea = marketLabel(evidence);
  var schemaObject = {
    '@context': 'https://schema.org',
    '@type': primaryType,
    name: name,
    description: cleanAssetText(category, 220)
  };
  if (siteUrl) schemaObject.url = siteUrl;
  if (serviceArea) schemaObject.areaServed = serviceArea;
  var jsonLd = '<script type="application/ld+json">\n'
    + JSON.stringify(schemaObject, null, 2)
    + '\n</script>';

  var fields = [
    'name: ' + name,
    siteUrl ? 'url: ' + siteUrl : null,
    'description: ' + category,
    serviceArea ? 'areaServed: ' + serviceArea : null,
    'schema type: ' + primaryType
  ].filter(Boolean);

  return {
    alreadyHasSchema: schemaConfirmed,
    schemaTypes:      schemaTypes,
    forwardTo:        'your developer or website manager',
    timeEstimate:     'Developer estimate required after reviewing the website setup',
    fields:           fields,
    jsonLd:           jsonLd,
    instruction:      schemaConfirmed
      ? 'CHOIVE found website facts code already on the site. Send the example below to your developer. Ask them to compare both versions, check every fact, and test the code before publishing it.'
      : 'CHOIVE did not find website facts code on the site. Send the example below to your developer. They must check every fact and test the code before publishing it.'
  };
}

function generateReviewAction(evidence, result) {
  var profile  = subjectProfile(evidence);
  var cityDisplay = capitaliseCity((evidence && evidence.city) || '');
  var name     = (evidence.name           || '').trim();
  var category = (result.inferredCategory || evidence.category || '').trim();
  var city     = (evidence.city           || '').trim();
  var pillars  = result.pillars           || {};
  var trustScore = (pillars.trust && pillars.trust.score) || 0;
  var trustEvidence = (pillars.trust && pillars.trust.evidence) || '';

  // Determine target platform and count by category
  var catLower = category.toLowerCase();
  var platform, secondaryPlatform, targetCount, secondaryTargetCount, platformUrl, instruction;
  var isReviewPlatform = true;
  var enterpriseProcurement = /enterprise|pay[ -]?tv|telco|telecom|operator|middleware|automotive oem|carmaker|broadcast platform/i.test(catLower);
  var realEstate = /real[ -]?estate|estate agenc|estate agent|property (?:broker|agency|sales)|residential brokerage/i.test(catLower);
  var internationalRealEstate = realEstate && /international|luxury|expat|foreign|global|costa del sol|marbella|investment/i.test(catLower + ' ' + String((evidence && evidence.description) || ''));
  var localCustomerBusiness = /restaurant|cafe|hotel|dentist|dental|clinic|doctor|salon|barber|spa|gym|fitness club|plumber|electrician|cleaning service|repair service|local shop|retail store/i.test(catLower);

  // Use a named platform only when this diagnostic established that buyers or
  // close competitors in the category use it. Category words alone are not
  // evidence that a particular directory matters.
  var modelPlatform = result.recommendedPlatform;
  if (profile.type === 'creator' || profile.type === 'personal_brand') {
    platform = 'Independent authority proof';
    targetCount = 3;
    platformUrl = '';
    isReviewPlatform = false;
    instruction = 'Publish three real examples that show why people should trust this person. Use named press stories, public appearances, awards, or work with named partners. Add a link so each example can be checked. Never create a fake review.';
  } else if (profile.type === 'organization') {
    platform = 'Verified organizational proof';
    targetCount = 3;
    platformUrl = '';
    isReviewPlatform = false;
    instruction = 'Publish three real examples that show what this organization has done. Name the partner, registration, program, or result. Add a link so people can check each example.';
  } else if (enterpriseProcurement) {
    platform = 'Named customer results';
    targetCount = 3;
    platformUrl = '';
    isReviewPlatform = false;
    instruction = 'Publish three approved customer stories. Name the customer, explain what they bought, and show the result. Add a public source when one exists. Do not create a review profile unless buyers in this market use it.';
  } else if (realEstate) {
    platform = 'Google Reviews';
    secondaryPlatform = internationalRealEstate ? 'Trustpilot' : '';
    targetCount = 5;
    secondaryTargetCount = secondaryPlatform ? 5 : 0;
    platformUrl = '';
    instruction = 'First confirm the correct Google Business Profile and ask recent customers for honest Google reviews. '
      + (secondaryPlatform
        ? 'Then check whether the agency already has a Trustpilot profile before creating one, and invite confirmed international clients to leave honest reviews there.'
        : 'Keep the business name, website, address, and contact details consistent on the profile.');
  } else if (localCustomerBusiness) {
    platform = 'Google Reviews';
    targetCount = 10;
    platformUrl = '';
    instruction = 'Confirm the correct Google Business Profile. Check the business name, website, address, phone number, and opening hours. Then ask recent customers for honest Google reviews and send them the correct profile link.';
  } else if (modelPlatform && modelPlatform.name) {
    platform    = modelPlatform.name;
    platformUrl = modelPlatform.url || '';
    instruction = (modelPlatform.reason || '') + (platformUrl ? ' Go to ' + platformUrl + ' and get started.' : '');
    targetCount = 25;
  } else {
    platform = profile.proof.charAt(0).toUpperCase() + profile.proof.slice(1);
    targetCount = 3;
    platformUrl = '';
    isReviewPlatform = false;
    instruction = profile.type === 'product'
      ? 'Publish three real user examples or honest reviews. Say who the product helps, what they used it for, and what happened. Add a link so people can check each example.'
      : 'Publish three real customer examples. Name the customer when permission is given, or clearly name the kind of buyer. Say what they bought and what happened. Add a link so people can check each example.';
  }

  // Counts are platform-specific. Never reuse an employee-review count from
  // Glassdoor as the customer-review count for G2, Google, or Trustpilot.
  var signals = (evidence && evidence.websiteSignals) || {};
  var currentCount = 0;
  if (/google/i.test(platform || '') && Number(signals.googleReviewCount) > 0) {
    currentCount = Number(signals.googleReviewCount);
  } else if (/trustpilot/i.test(platform || '') && Number(signals.trustpilotReviewCount) > 0) {
    currentCount = Number(signals.trustpilotReviewCount);
  }

  targetCount = targetCount || 25;
  var gap = Math.max(0, targetCount - currentCount);

  return {
    platform:     platform,
    secondaryPlatform: secondaryPlatform || '',
    platformUrl:  platformUrl,
    currentCount: currentCount,
    targetCount:  targetCount,
    secondaryTargetCount: secondaryTargetCount || 0,
    gap:          gap,
    instruction:  instruction,
    isReviewPlatform: isReviewPlatform,
    urgency:      trustScore < 8 ? 'critical' : trustScore < 14 ? 'high' : 'medium'
  };
}


function generateActionPlan(evidence, result) {
  var profile  = subjectProfile(evidence);
  var name     = (evidence.name || '').trim();
  var actions  = result.actions || [];
  var pillars  = result.pillars || {};
  var delivs   = result.deliverables || {};

  var critical = actions.filter(function(a) { return a.priority === 'critical'; });
  var high     = actions.filter(function(a) { return a.priority === 'high'; });
  var medium   = actions.filter(function(a) { return a.priority === 'medium'; });

  // ── Dedupe across weeks — the same action must never appear in two weeks
  var usedTitles = {};
  function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function markUsed(t)  { var n = normTitle(t); if (n) usedTitles[n] = true; }
  function firstUnused(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].title && !usedTitles[normTitle(list[i].title)]) return list[i];
    }
    return null;
  }
  // Owner is decided by what the task IS, not which week it lands in.
  // A founder task like emailing customers for G2 reviews must never say "developer".
  function taskOwner(a) {
    var text = (a.title || '') + ' ' + (a.body || '');
    return /schema|llms\.txt|markup|structured data|json-ld|sitemap|robots\.txt|meta tag|canonical|redirect|H1 tag|code|deploy/i.test(text) ? 'developer' : 'you';
  }

  var easeScore  = (pillars.ease  && pillars.ease.score)  || 0;
  var trustScore = (pillars.trust && pillars.trust.score) || 0;

  var weeks = [];

  // Week 1 — owner can do today, no developer needed
  var week1 = { week: 1, title: 'Do today — no developer needed', tasks: [] };
  if (easeScore < 18) {
    week1.tasks.push({
      task:   'Publish your AI facts file (llms.txt)',
      how:    'Copy the AI facts file from the Assets tab. Check every fact. Save it as llms.txt. Ask your website manager to place it at yourdomain.com/llms.txt.',
      impact: 'Completion check: yourdomain.com/llms.txt opens normally and shows only the approved facts',
      owner:  'you'
    });
  }
  if (pillars.clarity && pillars.clarity.score < 22) {
    week1.tasks.push({
      task:   'Update your homepage headline',
      how:    'Copy one of the main homepage headline options from the Assets tab. Update it in your website editor.',
      impact: 'Completion check: the live headline clearly names what you offer and who it is for',
      owner:  'you'
    });
  }
  week1.tasks.push({
    task:   'Update your search result description',
    how:    'Copy the improved search result description from the Assets tab. Paste it into the matching field in your website settings.',
    impact: 'Completion check: the approved description appears in the live page code',
    owner:  'you'
  });
  weeks.push(week1);

  // Week 2 — trust building
  var week2 = { week: 2, title: 'Build independent proof — start this week', tasks: [] };
  if (trustScore < 12) {
    var ra = delivs.reviewAction || {};
    if (ra.isReviewPlatform === false) {
      week2.tasks.push({
        task:   'Publish three proof points people can check',
        how:    ra.instruction || 'Publish three real examples. For each example, name what happened and show where a buyer can check it.',
        impact: 'Completion check: all three examples are public and each one has a source a buyer can open',
        owner:  'you'
      });
    } else {
      var reviewPlatforms = ra.secondaryPlatform
        ? (ra.platform + ' and ' + ra.secondaryPlatform)
        : (ra.platform || 'a category-relevant review platform');
      var reviewProfileLabel = ra.secondaryPlatform
        ? (ra.platform + ' profile and ' + ra.secondaryPlatform + ' profile')
        : ((ra.platform || 'review') + ' profile');
      week2.tasks.push({
        task:   'Confirm your ' + reviewProfileLabel,
        how:    ra.instruction || 'Create the profile and confirm that buyers in this category actively use the platform.',
        impact: 'Completion check: each profile opens, names the correct business, and links to the correct website',
        owner:  'you'
      });
      week2.tasks.push({
        task:   'Email your 10 best customers asking for a review',
        how:    'Ask for honest feedback on ' + reviewPlatforms + ' and include the correct verified profile link.',
        impact: 'Completion check: each customer receives the correct review link',
        owner:  'you'
      });
    }
  }
  var w2act = firstUnused(high);
  if (w2act) {
    markUsed(w2act.title);
    week2.tasks.push({
      task:   w2act.title,
      how:    firstSentence(w2act.body) + ' Full brief in Priority Actions.',
      impact: w2act.explanation || 'Improves selection confidence',
      owner:  taskOwner(w2act)
    });
  }
  weeks.push(week2);

  // Week 3 — developer tasks
  var week3 = { week: 3, title: 'Forward to your developer', tasks: [] };
  if (easeScore < 14) {
    week3.tasks.push({
      task:   'Add the website facts code to the main page',
      how:    'Send the website facts code to your developer. Ask them to check every fact, fit the code to the website, and test it before publishing it.',
      impact: 'Completion check: the live code passes a code test and contains only facts you approved',
      owner:  'developer'
    });
  }
  // Prefer an unused TECHNICAL action (critical[0] stays reserved for the
  // headline action elsewhere in the report); fall back to any unused critical.
  var w3act = null;
  for (var ci = 1; ci < critical.length; ci++) {
    var cand = critical[ci];
    if (cand && cand.title && !usedTitles[normTitle(cand.title)] && taskOwner(cand) === 'developer') { w3act = cand; break; }
  }
  if (!w3act) w3act = firstUnused(critical.slice(1));
  if (w3act) {
    markUsed(w3act.title);
    week3.tasks.push({
      task:   w3act.title,
      how:    firstSentence(w3act.body) + ' Full brief in Priority Actions.',
      impact: w3act.explanation || 'Critical for AI selection',
      owner:  taskOwner(w3act)
    });
  }
  weeks.push(week3);

  // Week 4 — measure
  var week4 = { week: 4, title: 'Measure your progress', tasks: [] };
  week4.tasks.push({
    task:   'Run a new CHOIVE diagnostic',
    how:    'Go to choive.com and run the same check again for ' + name + '. CHOIVE will show which changes are live and whether the score moved.',
    impact: 'Completion check: the old and new results can be placed side by side',
    owner:  'you'
  });
  var w4act = firstUnused(medium);
  if (w4act) {
    markUsed(w4act.title);
    week4.tasks.push({
      task:   w4act.title,
      how:    w4act.body,
      impact: w4act.explanation || 'Ongoing improvement',
      owner:  taskOwner(w4act)
    });
  }
  weeks.push(week4);

  return { name: name, weeks: weeks };
}

function generateDeliverables(evidence, result) {
  var delivs = {
    llmsTxt:      generateLlmsTxt(evidence, result),
    h1Options:    generateH1Options(evidence, result),
    metaDesc:     generateMetaDescription(evidence, result),
    schemaBrief:  generateSchemaBrief(evidence, result),
    reviewAction: generateReviewAction(evidence, result)
  };
  delivs.actionPlan = generateActionPlan(evidence, Object.assign({}, result, { deliverables: delivs }));
  return delivs;
}

module.exports = { generateDeliverables: generateDeliverables };
