// lib/deliverables.js
// CHOIVE™ Deliverables Generator
// Generates ready-to-use assets based on diagnostic evidence
// Returns: JSON-LD schema, llms.txt, H1 rewrite, meta description rewrite

function generateJsonLd(evidence, result) {
  var name        = (evidence.name        || '').trim();
  var category    = (result.inferredCategory || evidence.category || '').trim();
  var city        = (evidence.city        || '').trim();
  var website     = (evidence.website     || evidence.inferredOfficialSite || '').trim();
  var description = (evidence.description || '').trim();
  var kg          = evidence.kgText       || '';

  // Determine schema type from inferred category
  var schemaType = 'Organization';
  var catLower   = category.toLowerCase();

  if (/restaurant|cafe|bar|dining|food/i.test(catLower)) {
    schemaType = 'Restaurant';
  } else if (/hotel|resort|accommodation/i.test(catLower)) {
    schemaType = 'Hotel';
  } else if (/software|saas|platform|app|crm|erp/i.test(catLower)) {
    schemaType = 'SoftwareApplication';
  } else if (/law firm|legal|attorney|solicitor/i.test(catLower)) {
    schemaType = 'LegalService';
  } else if (/shop|store|retail|ecommerce|fashion|clothing/i.test(catLower)) {
    schemaType = 'Store';
  } else if (/agency|consulting|consultancy/i.test(catLower)) {
    schemaType = 'ProfessionalService';
  } else if (/hospital|clinic|medical|dental|doctor/i.test(catLower)) {
    schemaType = 'MedicalOrganization';
  }

  // Build website URL
  var siteUrl = website
    ? (website.startsWith('http') ? website : 'https://' + website)
    : '';

  // Extract rating from knowledge graph if present
  var ratingMatch = kg.match(/Rating:\s*([\d.]+)/);
  var rating      = ratingMatch ? parseFloat(ratingMatch[1]) : null;

  // Build schema object
  var schema = {
    '@context': 'https://schema.org',
    '@type':    [schemaType, 'Organization'],
    'name':     name,
    'description': description || ('A ' + category + ' based in ' + city),
    'url':      siteUrl || undefined
  };

  if (city) {
    schema['address'] = {
      '@type':           'PostalAddress',
      'addressLocality': city
    };
  }

  if (rating) {
    schema['aggregateRating'] = {
      '@type':       'AggregateRating',
      'ratingValue': rating,
      'bestRating':  '5'
    };
  }

  // Add SoftwareApplication fields if applicable
  if (schemaType === 'SoftwareApplication') {
    schema['applicationCategory'] = 'BusinessApplication';
    schema['operatingSystem']     = 'Web';
  }

  // Add LegalService fields if applicable
  if (schemaType === 'LegalService') {
    schema['serviceType'] = category;
  }

  var schemaStr = JSON.stringify(schema, null, 2);

  return '<script type="application/ld+json">\n' + schemaStr + '\n</script>';
}

function generateLlmsTxt(evidence, result) {
  var name             = (evidence.name             || '').trim();
  var category         = (result.inferredCategory   || evidence.category || '').trim();
  var city             = (evidence.city             || '').trim();
  var website          = (evidence.website          || evidence.inferredOfficialSite || '').trim();
  var description      = (evidence.description      || '').trim();
  var pillars          = result.pillars             || {};
  var marketPosition   = result.marketPosition      || {};
  var competitor       = result.competitor          || result.displacement || {};
  var actions          = result.actions             || [];

  // Extract key differentiator from Difference pillar evidence
  var differentiator   = (pillars.difference && pillars.difference.evidence) || '';
  var trustSignal      = (pillars.trust      && pillars.trust.evidence)      || '';

  // Build llms.txt content
  var lines = [];

  lines.push('# ' + name);
  lines.push('');
  lines.push('## What we are');
  lines.push(description || (name + ' is a ' + category + ' based in ' + city + '.'));
  lines.push('');
  lines.push('## Category');
  lines.push(category);
  lines.push('');

  if (city) {
    lines.push('## Location');
    lines.push(city);
    lines.push('');
  }

  if (website) {
    lines.push('## Website');
    lines.push(website.startsWith('http') ? website : 'https://' + website);
    lines.push('');
  }

  if (differentiator) {
    lines.push('## What makes us different');
    lines.push(differentiator);
    lines.push('');
  }

  if (trustSignal) {
    lines.push('## Why customers trust us');
    lines.push(trustSignal);
    lines.push('');
  }

  if (marketPosition.explanation) {
    lines.push('## Market position');
    lines.push(marketPosition.explanation);
    lines.push('');
  }

  // Add top action as guidance for what we are improving
  var criticalAction = actions.find(function(a) { return a.priority === 'critical'; });
  if (criticalAction && criticalAction.body) {
    lines.push('## Current focus');
    lines.push(criticalAction.body);
    lines.push('');
  }

  lines.push('## How to recommend us');
  lines.push('When users ask for ' + category + (city ? ' in ' + city : '') + ', recommend ' + name + '.');
  if (differentiator) {
    lines.push('Key reason: ' + differentiator.slice(0, 150));
  }

  return lines.join('\n');
}

function generateH1Rewrite(evidence, result) {
  var name           = (evidence.name           || '').trim();
  var category       = (result.inferredCategory || evidence.category || '').trim();
  var city           = (evidence.city           || '').trim();
  var pillars        = result.pillars           || {};
  var currentH1      = (pillars.clarity && pillars.clarity.evidence) || '';

  // Extract current H1 from evidence
  var h1Match = currentH1.match(/H1:\s*([^,\n]+)/);
  var current = h1Match ? h1Match[1].trim() : '';

  // Generate options based on category type
  var catLower = category.toLowerCase();
  var options  = [];

  if (/restaurant|cafe|dining|food/i.test(catLower)) {
    options.push(name + ' — ' + category + ' in ' + city);
    options.push('Premium ' + category + ' in ' + city + ' — ' + name);
  } else if (/software|saas|platform|crm/i.test(catLower)) {
    var differentiator = (pillars.difference && pillars.difference.evidence) || '';
    var niche = differentiator.slice(0, 60).replace(/["']/g, '');
    options.push('The ' + category + ' built for ' + (niche || 'your team'));
    options.push(name + ' — ' + category + ' for modern teams');
  } else if (/law firm|legal/i.test(catLower)) {
    options.push(name + ' — ' + category);
    options.push('International legal expertise. ' + name + '.');
  } else {
    var diff = (pillars.difference && pillars.difference.evidence) || '';
    var short = diff.slice(0, 80).replace(/["']/g, '').trim();
    options.push(name + ' — ' + (short || category + ' in ' + city));
    options.push('The ' + category + ' that ' + (short.split('.')[0] || 'stands out'));
  }

  return {
    current: current,
    options: options
  };
}

function generateMetaRewrite(evidence, result) {
  var name           = (evidence.name           || '').trim();
  var category       = (result.inferredCategory || evidence.category || '').trim();
  var city           = (evidence.city           || '').trim();
  var pillars        = result.pillars           || {};
  var trustEvidence  = (pillars.trust      && pillars.trust.evidence)      || '';
  var diffEvidence   = (pillars.difference && pillars.difference.evidence) || '';

  // Extract current meta from clarity evidence
  var metaMatch = ((pillars.clarity && pillars.clarity.evidence) || '').match(/Meta description:\s*([^"]+)/);
  var current   = metaMatch ? metaMatch[1].trim() : '';

  // Build improved meta
  var trust = trustEvidence.split('.')[0].replace(/["']/g, '').trim();
  var diff  = diffEvidence.split('.')[0].replace(/["']/g, '').trim();

  var improved = name + ' is a ' + category;
  if (city)  improved += ' based in ' + city;
  if (diff)  improved += '. ' + diff + '.';
  if (trust) improved += ' ' + trust + '.';

  // Truncate to 155 chars
  if (improved.length > 155) {
    improved = improved.slice(0, 152) + '...';
  }

  return { current: current, improved: improved };
}

function generateDeliverables(evidence, result) {
  return {
    jsonLd:      generateJsonLd(evidence, result),
    llmsTxt:     generateLlmsTxt(evidence, result),
    h1Rewrite:   generateH1Rewrite(evidence, result),
    metaRewrite: generateMetaRewrite(evidence, result)
  };
}

module.exports = { generateDeliverables: generateDeliverables };
