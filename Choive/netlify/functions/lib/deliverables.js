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

function sourceLinks(result) {
  var audits = result && result.scoreMethod && result.scoreMethod.audits;
  var trust = audits && Array.isArray(audits.trust) ? audits.trust : [];
  var links = [];
  trust.forEach(function(rule) {
    if (!rule || Number(rule.points || 0) <= 0 || rule.verification !== 'independent') return;
    var values = Array.isArray(rule.source) ? rule.source : [rule.source];
    values.forEach(function(value) {
      var link = String(value || '').trim();
      if (/^https?:\/\//i.test(link) && links.indexOf(link) === -1) links.push(link);
    });
  });
  return links.slice(0, 5);
}

var ASSET_STOP_WORDS = new Set(('the a an and or for with from into this that these those your our their its is are was were be to of in on at by as it we you they business company organization product service services solutions platform providing provides offers based').split(' '));
var UNSUPPORTED_ASSET_CLAIMS = /\b(best|leading|leader|market-leading|premium|trusted|award[- ]winning|number one|#1|top-rated|world-class|proven results?|guaranteed|teams trust|built for results|stands out|every detail matters)\b/i;

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
      audiences: (Array.isArray(facts.audiences) ? facts.audiences : []).map(function(v) { return supportedAssetText(v, evidence, result, 3, 100); }).filter(Boolean).slice(0, 4),
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
  var audience       = (modelFacts.audiences && modelFacts.audiences[0]) || intendedAudience(evidence, result, profile.audience);
  var independent    = sourceLinks(result);
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
  if (siteUrl && signals.hasRobots) lines.push('- [Crawler policy](' + siteUrl.replace(/\/$/, '') + '/robots.txt)');
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
  add(summary + (place && summary.toLowerCase().indexOf(place.toLowerCase()) === -1 ? ' — ' + place : ''));
  add(category + (place && category.toLowerCase().indexOf(place.toLowerCase()) === -1
    ? (place === 'Worldwide' ? ' — Worldwide' : ' in ' + place) : '') + ' | ' + name);
  if (diff) add(name + ' — ' + diff);
  else if (normalizeForAsset(summary).indexOf(normalizeForAsset(name)) !== 0) add(name + ' — ' + (summary || category));

  return { current: current, options: options.slice(0, 3) };
}

function generateMetaDescription(evidence, result) {
  var name     = (evidence.name           || '').trim();
  var category = (result.inferredCategory || evidence.category || '').trim();
  var city     = (evidence.city           || '').trim();
  var pillars  = result.pillars           || {};
  var cityDisplay = capitaliseCity(city);
  
  var clarityEvidence = (pillars.clarity    && pillars.clarity.evidence)    || '';
  var diffEvidence    = (pillars.difference && pillars.difference.evidence) || '';
  var trustEvidence   = (pillars.trust      && pillars.trust.evidence)      || '';

  // Extract current meta
  var metaMatch = clarityEvidence.match(/[Mm]eta description[:\s]+([^\n"]+)/);
  var current   = metaMatch ? metaMatch[1].trim().replace(/['"]/g, '') : '';

  // Filter raw evidence noise before using in meta
  var diffIsNoise   = /search query|site:|confirmed:|schema|homepage content|no competitor/i.test(diffEvidence);
  var trustIsNoise  = /search query|site:trustpilot|site:g2|site:glassdoor|returned Choice|Zero results|WEBSITE VISIBLE/i.test(trustEvidence);

  var diff  = diffIsNoise  ? '' : diffEvidence.replace(/["']/g, '').split('.')[0].trim();
  var trust = trustIsNoise ? '' : trustEvidence.replace(/["']/g, '').split('.')[0].trim();

  var groundedSummary = cleanAssetText(removeNameIntroduction(factualSummary(evidence, result, 145), name), 135);
  var improved = name + (groundedSummary ? ' — ' + groundedSummary : ' — ' + category);
  if (city && improved.toLowerCase().indexOf(cityDisplay.toLowerCase()) === -1) improved += ' in ' + cityDisplay;
  improved = improved.replace(/[.!?]?$/, '.');
  // Only append the trust sentence if the whole thing still fits in 155 chars
  if (trust && trust.length < 100 && (improved.length + trust.length + 2) <= 155) {
    improved += ' ' + trust + '.';
  }
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

  // Determine schema types needed
  var catLower    = category.toLowerCase();
  var schemaTypes = profile.type === 'creator' || profile.type === 'personal_brand'
    ? ['Person', 'ProfilePage']
    : profile.type === 'product'
      ? ['Product']
      : ['Organization'];

  if      (profile.type === 'creator' || profile.type === 'personal_brand' || profile.type === 'product') {}
  else if (/restaurant|cafe|dining/i.test(catLower))           schemaTypes.push('Restaurant');
  else if (/software|saas|platform|crm/i.test(catLower))       schemaTypes.push('SoftwareApplication');
  else if (/law firm|legal/i.test(catLower))                   schemaTypes.push('LegalService');
  else if (/beef|meat|food|butcher|farm/i.test(catLower))      schemaTypes.push('FoodEstablishment');
  else if (/shop|store|retail|fashion|clothing/i.test(catLower)) schemaTypes.push('Store');
  else if (/hotel|resort/i.test(catLower))                     schemaTypes.push('Hotel');
  else if (/dentist|dental/i.test(catLower))                   schemaTypes.push('Dentist');
  else if (/clinic|medical|doctor|healthcare/i.test(catLower)) schemaTypes.push('MedicalOrganization');
  else if (/bank|insurance|financial|wealth|mortgage/i.test(catLower)) schemaTypes.push('FinancialService');
  else if (/school|university|college|education|academy/i.test(catLower)) schemaTypes.push('EducationalOrganization');
  else if (/consulting|consultancy|accounting|accountant|architect|professional service/i.test(catLower)) schemaTypes.push('ProfessionalService');
  else if (/gym|fitness|sports club|wellness/i.test(catLower)) schemaTypes.push('SportsActivityLocation');
  else if (/car dealer|auto dealer|automotive retail/i.test(catLower)) schemaTypes.push('AutoDealer');
  else if (/real estate|estate agent|property agency|realtor/i.test(catLower)) schemaTypes.push('RealEstateAgent');

  var siteUrl = website
    ? (website.startsWith('http') ? website : 'https://' + website)
    : 'your website URL';

  var fields = [
    'name: ' + name,
    'url: ' + siteUrl,
    'description: ' + (category + (cityDisplay ? ' based in ' + cityDisplay : '')),
    city ? 'address.addressLocality: ' + city : null,
    'schema types: ' + schemaTypes.join(' + ')
  ].filter(Boolean);

  return {
    alreadyHasSchema: schemaConfirmed,
    schemaTypes:      schemaTypes,
    forwardTo:        'your developer or website manager',
    timeEstimate:     '20 minutes',
    fields:           fields,
    instruction:      schemaConfirmed
      ? 'Your website already has schema markup. Ask your developer to verify it includes all the fields below and matches the types listed.'
      : 'Your website is missing schema markup. Forward this to your developer or website manager. Ask them to add JSON-LD schema with the following details:'
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
  var platform, targetCount, platformUrl, instruction;
  var isReviewPlatform = true;
  var enterpriseProcurement = /enterprise|pay[ -]?tv|telco|telecom|operator|middleware|automotive oem|carmaker|broadcast platform/i.test(catLower);

  // Use a named platform only when this diagnostic established that buyers or
  // close competitors in the category use it. Category words alone are not
  // evidence that a particular directory matters.
  var modelPlatform = result.recommendedPlatform;
  if (profile.type === 'creator' || profile.type === 'personal_brand') {
    platform = 'Independent authority proof';
    targetCount = 3;
    platformUrl = '';
    isReviewPlatform = false;
    instruction = 'Publish or link three independently verifiable signals of authority, such as credited press coverage, recognized appearances, documented collaborations, awards, or complete profiles on the platforms where this audience already discovers people in this field. Do not manufacture reviews.';
  } else if (profile.type === 'organization') {
    platform = 'Verified organizational proof';
    targetCount = 3;
    platformUrl = '';
    isReviewPlatform = false;
    instruction = 'Publish three verifiable proof points appropriate to this organization: named partners, registrations or accreditations, independently reported outcomes, or documented programs. State who benefited, what happened, and where the claim can be checked.';
  } else if (enterpriseProcurement) {
    platform = 'Named customer results';
    targetCount = 3;
    platformUrl = '';
    isReviewPlatform = false;
    instruction = 'Publish three approved, named customer case studies with the buyer, deployment scope, and measurable outcome. Support them with coverage or citations from the trade press, analyst firms, or industry associations used by buyers in this category. Do not create a generic review-platform profile unless category evidence shows that procurement teams actually use it.';
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
      ? 'Publish three verifiable user examples or independent reviews that identify the use case, explain the result, and state where the claim can be checked. Use a review platform only when evidence confirms that users in this category rely on it.'
      : 'Publish three customer examples that name the customer or clearly identify the buyer type, explain what was purchased, and state a result that can be checked. Use a third-party review platform only after current evidence confirms that buyers in this exact category rely on it.';
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
    platformUrl:  platformUrl,
    currentCount: currentCount,
    targetCount:  targetCount,
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
      task:   'Upload llms.txt to your website root',
      how:    'Copy the llms.txt from the Assets tab. Save as llms.txt. Upload to your website file manager.',
      impact: 'Immediate — AI systems can now read a direct description of this ' + profile.noun,
      owner:  'you'
    });
  }
  if (pillars.clarity && pillars.clarity.score < 22) {
    week1.tasks.push({
      task:   'Update your homepage headline',
      how:    'Copy one of the H1 options from the Assets tab. Update it in your website editor.',
      impact: 'Clearer positioning for both visitors and AI systems within 24 hours',
      owner:  'you'
    });
  }
  week1.tasks.push({
    task:   'Update your meta description',
    how:    'Copy the improved meta description from the Assets tab. Paste into your website SEO settings.',
    impact: 'Better representation in search results and AI citations',
    owner:  'you'
  });
  weeks.push(week1);

  // Week 2 — trust building
  var week2 = { week: 2, title: 'Build independent proof — start this week', tasks: [] };
  if (trustScore < 12) {
    var ra = delivs.reviewAction || {};
    if (ra.isReviewPlatform === false) {
      week2.tasks.push({
        task:   'Publish ' + String(ra.platform || profile.proof).toLowerCase(),
        how:    ra.instruction || 'Publish three independent, verifiable proof points appropriate to this subject.',
        impact: 'Gives the relevant audience and AI systems evidence they can verify',
        owner:  'you'
      });
      week2.tasks.push({
        task:   'Secure three verifiable proof points',
        how:    ra.instruction || 'Collect three independently checkable examples that match this subject type and audience.',
        impact: 'Replaces unsupported claims with evidence people can check',
        owner:  'you'
      });
    } else {
      week2.tasks.push({
        task:   'Set up ' + (ra.platform || 'a category-relevant review platform') + ' business profile',
        how:    ra.instruction || 'Create the profile and confirm that buyers in this category actively use the platform.',
        impact: 'Every verified customer review builds independent credibility',
        owner:  'you'
      });
      week2.tasks.push({
        task:   'Email your 10 best customers asking for a review',
        how:    'Ask for honest feedback on ' + (ra.platform || 'the selected review platform') + ' and include the verified profile link.',
        impact: 'Begins building independent customer evidence',
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
      task:   'Add the correct schema markup to the main page',
      how:    'Forward the Schema brief from the Assets tab. Estimated 20 minutes for a developer.',
      impact: 'Structured data makes this ' + profile.noun + ' machine-readable and closes the main technical gap',
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
    how:    'Go to choive.com and run the diagnostic again for ' + name + '. The Verified Progress block will confirm — mechanically — exactly which fixes registered and how far the score moved.',
    impact: 'See exactly what changed and what gaps remain',
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
