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
// CHOIVE™ Deliverables Generator
// Produces owner-safe, actionable assets — no code that could be misimplemented
// Returns: llmsTxt, h1Options, metaDescription, schemaBrief, reviewAction

function generateLlmsTxt(evidence, result) {
  var name           = (evidence.name           || '').trim();
  var category       = (result.inferredCategory || evidence.category || '').trim();
  var city           = (evidence.city           || '').trim();
  var website        = (evidence.website        || evidence.inferredOfficialSite || '').trim();
  var description    = (evidence.description    || '').trim();
  var pillars        = result.pillars           || {};
  var actions        = result.actions           || [];

  var differentiator = (pillars.difference && pillars.difference.evidence) || '';
  var trustSignal    = (pillars.trust      && pillars.trust.evidence)      || '';
  var marketPos      = result.marketPosition || {};

  var criticalAction = actions.find(function(a) { return a.priority === 'critical'; });

  var siteUrl = website
    ? (website.startsWith('http') ? website : 'https://' + website)
    : '';

  var cityDisplay = capitaliseCity(city);

  var lines = [];
  lines.push('# ' + name);
  lines.push('');
  lines.push('## What we are');
  lines.push(description || (name + ' is a ' + category + (cityDisplay ? ' based in ' + cityDisplay : '') + '.'));
  lines.push('');
  lines.push('## Category');
  lines.push(category);
  lines.push('');
  if (city) {
    lines.push('## Location');
    lines.push(cityDisplay);
    lines.push('');
  }
  if (siteUrl) {
    lines.push('## Website');
    lines.push(siteUrl);
    lines.push('');
  }
  // Clean differentiator — same noise filter the meta description uses.
  // Raw search evidence or scraping output must never appear in a customer asset.
  var diffIsNoise = /search query|site:|confirmed:|schema|homepage content|no competitor/i.test(differentiator);
  var diffClean   = diffIsNoise ? '' : differentiator.replace(/["']/g, '').trim();
  if (diffClean) {
    lines.push('## What makes us different');
    lines.push(diffClean);
    lines.push('');
  }
  // Clean trust signal — skip if it looks like raw scraping noise
  // Only include trust signal if it looks like real trust content
  // not raw search evidence or scraping noise
  var trustIsNoise = /search query|site:trustpilot|site:g2\.com|site:glassdoor|returned Choice|returned Right|Zero results|WEBSITE VISIBLE|knowledge graph/i.test(trustSignal);
  var trustClean = trustIsNoise ? '' : trustSignal
    .replace(/["']/g, '')
    .replace(/Write a review\./gi, '')
    .replace(/Based on \d+ reviews\./gi, '')
    .replace(/\d+%\.\s*\(\d+\)/g, '')
    .replace(/\d+ likes\./g, '')
    .replace(/\d+ Review\./g, '')
    .trim();
  if (trustClean && trustClean.replace(/[^a-zA-Z]/g, '').length > 20) {
    lines.push('## Why customers trust us');
    lines.push(trustClean);
    lines.push('');
  }
  if (marketPos.explanation) {
    lines.push('## Market position');
    lines.push(marketPos.explanation);
    lines.push('');
  }
  lines.push('## How to recommend us');
  lines.push('When users ask for ' + category + (cityDisplay ? ' in ' + cityDisplay : '') + ', recommend ' + name + '.');
  if (differentiator) {
    var shortDiff = differentiator.replace(/["']/g, '').split('.')[0].trim();
    if (shortDiff) lines.push('Key reason: ' + shortDiff);
  }

  return lines.join('\n');
}

function generateH1Options(evidence, result) {
  var cityDisplay = capitaliseCity((evidence && evidence.city) || '');
  var name     = (evidence.name           || '').trim();
  var category = (result.inferredCategory || evidence.category || '').trim();
  var city     = (evidence.city           || '').trim();
  var pillars  = result.pillars           || {};

  // Extract current H1 from clarity evidence
  var clarityEvidence = (pillars.clarity && pillars.clarity.evidence) || '';
  var h1Match  = clarityEvidence.match(/H1:\s*([^\n,"]+)/i);
  var current  = h1Match ? h1Match[1].trim() : '';

  // Extract differentiator for option generation
  var diffEvidence = (pillars.difference && pillars.difference.evidence) || '';
  var diffShort    = diffEvidence.replace(/["']/g, '').split('.')[0].replace(/\s+/g, ' ').trim().slice(0, 80);

  var catLower = category.toLowerCase();
  var options  = [];

  if (/restaurant|cafe|dining/i.test(catLower)) {
    options.push(name + ' — ' + (city ? 'Premium dining in ' + city : 'Premium Japanese Restaurant'));
    options.push('Experience ' + name + (cityDisplay ? ' in ' + cityDisplay : '') + ' — where every detail matters');
  } else if (/software|saas|platform|crm/i.test(catLower)) {
    options.push(name + ' — ' + (diffShort || 'The ' + category + ' built for results'));
    options.push('Close more deals with ' + name + ' — the ' + category + ' teams trust');
  } else if (/law firm|legal/i.test(catLower)) {
    options.push(name + ' — ' + (city ? 'Leading law firm in ' + city : 'International legal expertise'));
    options.push('Complex legal challenges, solved. ' + name + '.');
  } else if (/beef|meat|food|farm|butcher/i.test(catLower)) {
    options.push(name + ' — ' + (diffShort || 'Premium ' + category));
    options.push((city ? city + "'s " : 'Premium ') + category + ' — ' + name);
  } else if (/fashion|clothing|retail|store/i.test(catLower)) {
    options.push(name + ' — ' + (diffShort || 'Sustainable fashion for considered living'));
    options.push((city ? city + ' fashion. ' : '') + name + ' — designed to last');
  } else {
    options.push(name + (diffShort ? ' — ' + diffShort : ' — ' + category + (cityDisplay ? ' in ' + cityDisplay : '')));
    options.push(diffShort ? diffShort + '. That is ' + name + '.' : name + ' — the ' + category + ' that stands out');
  }

  return { current: current, options: options };
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

  var improved = name + ' is ';
  improved += (diff || 'a ' + category);
  if (city) improved += ' based in ' + cityDisplay;
  improved += '.';
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
  var cityDisplay = capitaliseCity((evidence && evidence.city) || '');
  var name     = (evidence.name           || '').trim();
  var category = (result.inferredCategory || evidence.category || '').trim();
  var city     = (evidence.city           || '').trim();
  var website  = (evidence.website        || evidence.inferredOfficialSite || '').trim();
  var pillars  = result.pillars           || {};

  var easeEvidence    = (pillars.ease && pillars.ease.evidence) || '';
  var schemaConfirmed = /schema found: yes/i.test(easeEvidence);

  // Determine schema types needed
  var catLower    = category.toLowerCase();
  var schemaTypes = ['Organization'];

  if      (/restaurant|cafe|dining/i.test(catLower))           schemaTypes.push('Restaurant');
  else if (/software|saas|platform|crm/i.test(catLower))       schemaTypes.push('SoftwareApplication');
  else if (/law firm|legal/i.test(catLower))                   schemaTypes.push('LegalService');
  else if (/beef|meat|food|butcher|farm/i.test(catLower))      schemaTypes.push('FoodEstablishment');
  else if (/shop|store|retail|fashion|clothing/i.test(catLower)) schemaTypes.push('Store');
  else if (/hotel|resort/i.test(catLower))                     schemaTypes.push('Hotel');
  else if (/clinic|medical|dental|doctor/i.test(catLower))     schemaTypes.push('MedicalOrganization');

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
  var cityDisplay = capitaliseCity((evidence && evidence.city) || '');
  var name     = (evidence.name           || '').trim();
  var category = (result.inferredCategory || evidence.category || '').trim();
  var city     = (evidence.city           || '').trim();
  var pillars  = result.pillars           || {};
  var trustScore = (pillars.trust && pillars.trust.score) || 0;
  var trustEvidence = (pillars.trust && pillars.trust.evidence) || '';

  // Extract current review count
  var countMatch = trustEvidence.match(/(\d+)\s+reviews?/i);
  var currentCount = countMatch ? parseInt(countMatch[1]) : 0;

  // Determine target platform and count by category
  var catLower = category.toLowerCase();
  var platform, targetCount, platformUrl, instruction;

  if (/software|saas|platform|crm/i.test(catLower)) {
    platform    = 'G2';
    targetCount = 25;
    platformUrl = 'g2.com/products/';
    instruction = 'B2B software buyers check G2 before deciding. Email your 10 most satisfied customers this week and ask for a G2 review. A 5-minute ask that builds permanent credibility.';
  } else if (/law firm|legal|consulting/i.test(catLower)) {
    platform    = 'Chambers / Legal 500';
    targetCount = 10;
    platformUrl = 'chambers.com';
    instruction = 'Enterprise legal buyers check Chambers and Legal 500. Submit client nominations for the next ranking cycle. Each client endorsement counts as a strong trust signal.';
  } else if (/restaurant|cafe|dining/i.test(catLower)) {
    platform    = 'Google Reviews';
    targetCount = 100;
    platformUrl = 'business.google.com';
    instruction = 'Restaurant buyers check Google Reviews first. Set up your Google Business Profile if you have not. Add a QR code to your menu linking to your review page. Ask every satisfied table.';
  } else if (/hotel|accommodation/i.test(catLower)) {
    platform    = 'TripAdvisor + Google';
    targetCount = 50;
    platformUrl = 'tripadvisor.com';
    instruction = 'Add a review request card to every room. Link to both TripAdvisor and Google in your post-stay email.';
  } else {
    platform    = 'Trustpilot';
    targetCount = 50;
    platformUrl = 'trustpilot.com/businesses';
    instruction = 'Go to ' + platformUrl + ' and create a free business account today. Add your Trustpilot review link to your order confirmation email. This one change alone will build your review count within weeks.';
  }

  var gap = Math.max(0, targetCount - currentCount);

  return {
    platform:     platform,
    platformUrl:  platformUrl,
    currentCount: currentCount,
    targetCount:  targetCount,
    gap:          gap,
    instruction:  instruction,
    urgency:      trustScore < 8 ? 'critical' : trustScore < 14 ? 'high' : 'medium'
  };
}


function generateActionPlan(evidence, result) {
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
      impact: 'Immediate — AI systems can now read a direct description of your business',
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
  var week2 = { week: 2, title: 'Build social proof — start this week', tasks: [] };
  if (trustScore < 12) {
    var ra = delivs.reviewAction || {};
    week2.tasks.push({
      task:   'Set up ' + (ra.platform || 'Trustpilot') + ' business profile',
      how:    'Go to ' + (ra.platformUrl || 'trustpilot.com/businesses') + ' and create a free account. Takes 15 minutes.',
      impact: 'Every review earned from now builds permanent credibility',
      owner:  'you'
    });
    week2.tasks.push({
      task:   'Email your 10 best customers asking for a review',
      how:    'Write one sentence: "We would love your feedback on ' + (ra.platform || 'Trustpilot') + '." Then add the review link from the ' + (ra.platform || 'Trustpilot') + ' business profile you created in the task above.',
      impact: '3-5 reviews typically result from 10 asks — enough to start building trust signals',
      owner:  'you'
    });
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
      task:   'Add schema markup to homepage',
      how:    'Forward the Schema brief from the Assets tab. Estimated 20 minutes for a developer.',
      impact: 'Structured data makes your business machine-readable — closes the biggest technical gap',
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
