// run-diagnostic-background.js
// CHOIVE™ background diagnostic engine
// Stage 1: collect evidence — Stage 2: score — Stage 3: save
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPER_API_KEY, ANTHROPIC_API_KEY
// Optional second-platform measurement: OPENAI_API_KEY, OPENAI_MODEL,
// OPENAI_GROUND_TRUTH_SAMPLES
const { updateStatus, saveEvidence, saveResult, saveError, getCachedEvidence, buildFingerprint, getPreviousCompetitor, getPreviousResult } = require('./lib/supabase');
const { searchSerper, searchCompetitors, searchOnlineChannelCompetitor, inferOfficialSite, normalizeUrl } = require('./lib/serper');
const { fetchWebsiteText, fetchCompetitorText, fetchReviewPages, buildReviewText } = require('./lib/fetchWebsite');
const { scoreWithClaude, inferCategory, selectChannelCompetitor, scoreArena } = require('./lib/claude');
const { runOpenAISimulation } = require('./lib/openai-simulation');
const { hasValidShape, buildSafeOutput } = require('./lib/validators');
const { fetchSocialEvidence, buildSocialText } = require('./lib/social');
const { fetchApifyEvidence }   = require('./lib/apify');
const { generateDeliverables } = require('./lib/deliverables');
const { runSimulation, runBeforeSimulation, runAfterSimulation, runDirectCompetitorQuestion } = require('./lib/simulation');
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function safeStr(v) { return typeof v === 'string' ? v.trim() : ''; }
// ── VERIFICATION ENGINE ─────────────────────────────────────────────
// Compares this run against the previous completed run for the same business
// and produces a provable delta: score movement, per-pillar movement, and —
// because signals are mechanically confirmed — attributable changes ("llms.txt:
// absent → present"). The measure → prescribe → VERIFY loop no monitoring
// platform closes. Pure function; never throws into the pipeline.
function computeProgressDelta(prevRow, finalResult, evidence) {
  if (!prevRow || !prevRow.result || !finalResult) return null;
  var prev      = prevRow.result;
  var prevScore = Number(prev.score);
  var curScore  = Number(finalResult.overallScore);
  if (!isFinite(prevScore) || !isFinite(curScore)) return null;

  var delta = {
    previousJobId: prevRow.job_id || null,
    previousDate:  prevRow.created_at || null,
    previousScore: prevScore,
    scoreDelta:    curScore - prevScore,
    pillars:       {},
    signals:       [],
    selectionRate: null,
    competitorChange: null
  };

  var pKeys = ['clarity', 'trust', 'difference', 'ease'];
  for (var i = 0; i < pKeys.length; i++) {
    var k  = pKeys[i];
    var pp = prev.pillars && prev.pillars[k] ? Number(prev.pillars[k].score) : NaN;
    var cp = finalResult.pillars && finalResult.pillars[k] ? Number(finalResult.pillars[k].score) : NaN;
    if (isFinite(pp) && isFinite(cp)) delta.pillars[k] = cp - pp;
  }

  var prevSite = (prevRow.evidence && prevRow.evidence.website) || {};
  var curSite  = (evidence && evidence.website) || {};
  var sigMap = [
    ['hasSchema',          'Schema markup'],
    ['hasLlmsTxt',         'llms.txt'],
    ['hasH1',              'H1 tag'],
    ['hasTitle',           'Title tag'],
    ['hasMetaDescription', 'Meta description'],
    ['hasCanonical',       'Canonical tag'],
    ['hasSitemap',         'sitemap.xml'],
    ['hasRobots',          'robots.txt'],
    ['hasOgTags',          'OG tags']
  ];
  for (var s = 0; s < sigMap.length; s++) {
    var key = sigMap[s][0], label = sigMap[s][1];
    var was = prevSite[key] === true, now = curSite[key] === true;
    if (was !== now && (key in prevSite || key in curSite)) {
      delta.signals.push({ label: label, from: was, to: now });
    }
  }

  var prevB = prev.aiSimulation && prev.aiSimulation.before;
  var curB  = (finalResult.aiSimulation && finalResult.aiSimulation.before)
           || ((evidence.aiSimulationBefore || {}).before);
  if (prevB && curB && isFinite(Number(prevB.appearedCount)) && isFinite(Number(curB.appearedCount))) {
    delta.selectionRate = {
      previous: Number(prevB.appearedCount),
      current:  Number(curB.appearedCount),
      total:    Number(curB.totalQueries) || 3
    };
  }

  var prevComp = Array.isArray(prev.competitors) && prev.competitors[0] && prev.competitors[0].name
    ? String(prev.competitors[0].name).trim() : null;
  var curComp = Array.isArray(finalResult.competitors) && finalResult.competitors[0] && finalResult.competitors[0].name
    ? String(finalResult.competitors[0].name).trim() : null;
  if (prevComp && curComp && prevComp.toLowerCase() !== curComp.toLowerCase()) {
    delta.competitorChange = { from: prevComp, to: curComp };
  }

  return delta;
}

// Category fidelity guard: an inferred category that shares no distinctive
// word with the owner's own words has drifted into a different industry —
// the CHOIVE→"AI evaluation platform" bug. Owner's words win on zero overlap.
function categoryFaithful(ownerCategory, inferred) {
  // Stop list covers two groups:
  // 1. Pure connectives (the, and, for…) — never meaningful category words
  // 2. Generic industry/tech terms a user types when they don't know the right category
  //    (software, tech, solution, app, system, product…). When ALL of the user's tokens
  //    fall into this group, own[] is empty → return true → trust the inferred category.
  //    This prevents generic inputs like "software" or "tech solution" from blocking the
  //    correct inference (e.g. "B2B OTT middleware platform for telcos") while still
  //    protecting specific categories (e.g. "AI selection diagnostic") from drifting.
  var stop = {
    // connectives
    the:1, and:1, for:1, with:1, from:1, into:1, that:1, this:1,
    // generic business/model words
    b2b:1, b2c:1, online:1, platform:1, service:1, services:1, company:1,
    business:1, tool:1, agency:1, provider:1, global:1,
    // generic tech/product words — user typed these when unsure of real category
    software:1, tech:1, technology:1, technologies:1, solution:1, solutions:1,
    app:1, application:1, applications:1, system:1, systems:1, product:1, products:1,
    digital:1, web:1, saas:1, cloud:1, startup:1, startup:1, enterprise:1
  };
  var toks = function(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(function(w) { return w.length > 2 && !stop[w]; });
  };
  var own = toks(ownerCategory);
  if (!own.length) return true;
  var inf = {};
  toks(inferred).forEach(function(w) { inf[w] = 1; });
  for (var i = 0; i < own.length; i++) {
    var w = own[i];
    if (inf[w]) return true;
    // simple stem tolerance: diagnostic/diagnostics, roaster/roasters
    for (var k in inf) { if (k.indexOf(w) === 0 || w.indexOf(k) === 0) return true; }
  }
  return false;
}

// ── DETERMINISTIC COMPETITOR LAYER ─────────────────────────────────
// Pure code. The model may reason however it likes; these mechanisms make the
// final head-to-head slot correct regardless.

// Marketplaces, hubs, and infrastructure are channels, never rivals.
// A competitor must be a NAMED COMPANY, not a generic category description.
// "Bioland-zertifizierte Direktvermarkter" ("Bioland-certified direct
// marketers") is a class of seller, not a business — the extraction stage
// can grab a descriptive phrase out of an AI answer and mistake it for a
// name. This is a shape check, language-agnostic where possible.
var GENERIC_COLLECTIVE_RE = /\b(zertifizierte|direktvermarkter|retailers?|producers?|suppliers?|vendors?|sellers?|marketers?|farmers?|companies|businesses|providers?|brands?|stores?|shops?|outlets?|options|optionen|alternatives|alternativen|m\u00f6glichkeiten|varianten|empfehlungen|angebote|sources|h\u00e4ndler|anbieter|hersteller|erzeuger|betriebe|gesch\u00e4fte)\b/i;

function isGenericPhrase(n) {
  var s = String(n || '').trim();
  if (!s) return false;
  var words = s.split(/\s+/);
  // A real brand is almost always short (1-4 words). Longer AND containing a
  // collective/category noun is the descriptive-phrase signature.
  if (words.length >= 2 && GENERIC_COLLECTIVE_RE.test(s)) return true;
  if (words.length >= 5) return true; // no real brand name runs this long
  return false;
}

var PLATFORM_BLACKLIST_RE = /^(g2|g2\.com|trustpilot|capterra|clutch|yelp|tripadvisor|google|google maps|bing|amazon|ebay|etsy|facebook|meta|instagram|linkedin|x|twitter|youtube|tiktok|reddit|quora|wikipedia|hugging\s?face|github|gitlab|product\s?hunt|app\s?store|play\s?store|shopify app store|chatgpt|openai|claude|anthropic|gemini|perplexity)$/i;

// A "competitor" that is a generic category description, not a real named
// business, is not an entity at all — "Bioland-zertifizierte Direktvermarkter"
// ("Bioland-certified direct marketers") is the AI's answer summarized into a
// category, not a brand extracted from it. Multi-language generic-noun check:
// if the candidate is built entirely from category/certification/business-type
// words with no distinguishing brand token, it is not a real entity.
var GENERIC_ENTITY_RE = /\b(zertifizierte?|certified|organic|direktvermarkter|direct\s?marketers?|anbieter|providers?|erzeuger|producers?|landwirte|farmers?|bauern|farms?|h[o\u00f6]fe|hersteller|manufacturers?|betriebe|businesses?|vendors?|suppliers?|sellers?|retailers?|options?|companies|brands?|marketplaces?)\b/gi;
// Certification-scheme modifiers are never themselves a business — "Bioland",
// "Demeter", "Naturland" name a STANDARD, not a company. Strip the whole
// "[Scheme]-certified" compound, not just the suffix, or the scheme name
// survives the strip and is mistaken for a distinguishing brand word.
var CERT_SCHEME_RE = /\b(bioland|demeter|naturland|eu-?bio|usda|non-?gmo|fairtrade|rainforest\s?alliance)[\s-]?(zertifizierte?r?|certified)?\b/gi;

function isGenericEntity(n) {
  var name = String(n || '').trim();
  if (!name) return false;
  var stripped = name.replace(CERT_SCHEME_RE, ' ').replace(GENERIC_ENTITY_RE, ' ').replace(/[-\u2013\u2014]/g, ' ').replace(/\s+/g, ' ').trim();
  // If removing every generic/category word leaves nothing (or only 1-2 tiny
  // leftover characters), the whole name was built from category vocabulary
  // \u2014 it is a description, not a brand.
  return stripped.length < 3 || stripped.split(' ').filter(function(w) { return w.length > 2; }).length === 0;
}

function isPlatformName(n) {
  return PLATFORM_BLACKLIST_RE.test(String(n || '').trim().toLowerCase().replace(/\s+/g, ' '));
}

// A business that publishes "X vs Y", "/compare/y", or "alternative to Y" on
// its own site has DECLARED its rival. Extracted mechanically from site text.
function extractDeclaredCompetitors(siteText, subjectName) {
  var text = String(siteText || '');
  var found = [];
  var seen = {};
  var subject = String(subjectName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  var push = function(raw) {
    var n = String(raw || '').trim().replace(/[.,;:!?)\]]+$/, '');
    if (!n || n.length < 2 || n.length > 40) return;
    var key = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || key === subject || seen[key] || isPlatformName(n)) return;
    seen[key] = 1;
    found.push(n);
  };
  var m;
  var reVs = /\bvs\.?\s+([A-Z][A-Za-z0-9&-]{1,30}(?:\s+[A-Z][A-Za-z0-9&-]{1,20})?)/g;
  while ((m = reVs.exec(text)) !== null) push(m[1]);
  var reCompare = /\/compare\/([a-z0-9-]{2,30})/gi;
  while ((m = reCompare.exec(text)) !== null) push(m[1].replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }));
  var reAlt = /\balternative(?:s)?\s+to\s+([A-Z][A-Za-z0-9&-]{1,30})/g;
  while ((m = reAlt.exec(text)) !== null) push(m[1]);
  return found.slice(0, 3);
}

// ── DUAL-ARENA DETECTION ─────────────────────────────────────────────────────
// A business qualifies for dual-arena analysis when it has BOTH:
//   (1) A specialty-product identity: specific breed, origin, craft method, or
//       certification that creates a brand-level competitive comparison.
//   (2) A direct online/DTC channel: active e-commerce with physical delivery,
//       creating a separate channel-level competitive comparison.
// Generic "quality" or "premium" alone does not qualify — the signal must be
// a concrete differentiating attribute (breed name, DOP, single-origin, etc.).
// A restaurant with Deliveroo does NOT qualify — the channel is incidental.
// A Black Angus beef seller with home delivery DOES — two distinct buyer frames.
function detectDualArena(websiteText, category, description) {
  var text = [websiteText || '', category || '', description || ''].join(' ').toLowerCase();

  // Specialty-product signals — concrete differentiating attributes only
  var SPECIALTY = [
    // Livestock breeds
    /\b(black\s+angus|angus|wagyu|kobe|hereford|limousin|charolais|duroc|ib[eé]rico|berkshire|longhorn|galloway|shorthorn)\b/,
    // Rearing / feeding method
    /\b(grass[\s-]fed|pasture[\s-]raised|pasture[\s-]fed|free[\s-]range|heritage\s+breed|native\s+breed)\b/,
    // Agricultural traceability
    /\b(single[\s-]origin|single[\s-]estate|estate[\s-]grown|farm[\s-]to[\s-](table|door|fork)|direct[\s-]from[\s-](farm|producer))\b/,
    // Craft and artisan
    /\b(artisan(al)?|hand[\s-]crafted|hand[\s-]made|small[\s-]batch|craft\s+(beer|gin|whisky|whiskey|rum|spirits|chocolate|coffee|cider))\b/,
    // Aging and processing
    /\b(dry[\s-]aged|wet[\s-]aged|cave[\s-]aged|barrel[\s-]aged|cold[\s-]pressed|stone[\s-]milled|slow[\s-]roasted)\b/,
    // Coffee specifics
    /\b(single[\s-]origin\s+coffee|specialty\s+coffee|micro[\s-]roast|nano[\s-]roast|third[\s-]wave\s+coffee)\b/,
    // Wine and spirits terroir
    /\b(appellation|terroir|grand\s+cru|premier\s+cru|chateau|domaine|bodega|denominaci[oó]n\s+de\s+origen)\b/,
    // Protected designations (multilingual)
    /\b(dop|igp|aop|pdo|pgi|doc|docg|aoc|d\.o\.p|d\.o)\b/,
  ];

  // Online DTC channel signals — active e-commerce with delivery, not just presence
  var ONLINE_CHANNEL = [
    /\b(order\s+online|shop\s+online|buy\s+online|online\s+(shop|store|butcher|bakery|deli|fishmonger))\b/,
    /\b(home\s+delivery|next[\s-]day\s+delivery|same[\s-]day\s+delivery|nationwide\s+delivery|deliver\s+(to\s+your\s+door|across|throughout))\b/,
    /\b(add\s+to\s+(cart|basket)|place\s+your\s+order|checkout)\b/,
    /\b(direct[\s-]to[\s-]consumer|d\.t\.c|dtc|d2c)\b/,
    /\b(subscription\s+box|monthly\s+box|meat\s+box|fish\s+box|veg\s+box|coffee\s+subscription|weekly\s+delivery)\b/,
    /\b(cold[\s-]chain|vacuum[\s-]pack(ed|aging)?|chilled\s+delivery|refrigerated\s+delivery|insulated\s+packaging)\b/,
    /\b(free\s+(shipping|delivery)|fast\s+shipping|express\s+delivery|tracked\s+delivery)\b/,
  ];

  var specialtyHit = SPECIALTY.find(function(re) { return re.test(text); }) || null;
  var onlineHit    = ONLINE_CHANNEL.find(function(re) { return re.test(text); }) || null;

  if (specialtyHit && onlineHit) {
    return {
      dualArena: true,
      arenas: [
        { type: 'brand',  label: 'Brand & Product' },
        { type: 'online', label: 'Online Channel'   }
      ],
      _debug: { specialtyPattern: specialtyHit.toString(), onlinePattern: onlineHit.toString() }
    };
  }

  return { dualArena: false };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  let jobId;
  try {
    const body  = JSON.parse(event.body || '{}');
    jobId       = safeStr(body.jobId);
    const input = body.input && typeof body.input === 'object' ? body.input : {};
    const name             = safeStr(input.name);
    const category         = safeStr(input.category);
    const city             = safeStr(input.city);
    const website          = safeStr(input.website);
    const description      = safeStr(input.description);
    const knownCompetitors = safeStr(input.knownCompetitors);
    const languagePref     = (['de','es','fr','it','nl','pt','pl','tr','sv','da','ja','ko','zh','en','ar','ru','hi','id'].indexOf(safeStr(input.language).toLowerCase()) !== -1) ? safeStr(input.language).toLowerCase() : '';
    if (!jobId)                      throw new Error('Missing jobId');
    if (!name || !category || !city) throw new Error('Missing required input fields');
    await updateStatus(jobId, 'collecting_evidence', 'collecting_evidence').catch(() => {});
    // ── CACHE CHECK — reuse recent evidence for the same business ────────────
    const fingerprint = buildFingerprint({ name, category, city });
    const cached = await getCachedEvidence(fingerprint, 24).catch(() => null);
    let evidence = null;
    let cacheBustedThisRun = false;

    if (cached && cached.evidence) {
      // ── REALITY CHECK — the cache is valid only if the website hasn't changed.
      // One cheap fetch. If the customer implemented fixes since the cached run
      // (new llms.txt, new H1, new schema types...), the cache is stale by
      // definition: bust it and re-measure everything NOW, so verification
      // never makes someone wait a day to see their own work count.
      var cacheValid = true;
      if (website) {
        try {
          var freshSite = await fetchWebsiteText(website);
          var freshSig  = (freshSite && freshSite.signals) || {};
          var cachedSig = (cached.evidence && cached.evidence.websiteSignals) || {};
          var sigKeys = ['hasSchema','hasLlmsTxt','hasH1','hasTitle','hasMetaDescription','hasCanonical','hasSitemap','hasRobots','hasOgTags'];
          var changed = sigKeys.filter(function(k) { return (freshSig[k] === true) !== (cachedSig[k] === true); });
          var freshTypes  = Array.isArray(freshSig.schemaTypes)  ? freshSig.schemaTypes.length  : 0;
          var cachedTypes = Array.isArray(cachedSig.schemaTypes) ? cachedSig.schemaTypes.length : 0;
          if (freshTypes !== cachedTypes) changed.push('schemaTypes(' + cachedTypes + '\u2192' + freshTypes + ')');
          if (changed.length > 0) {
            cacheValid = false;
            cacheBustedThisRun = true;
            console.log('[' + jobId + '] Cache busted \u2014 website changed since cached run: ' + changed.join(', '));
          }
        } catch (err) {
          console.warn('[' + jobId + '] Cache revalidation fetch failed, keeping cache:', err.message);
        }
      }
      if (cacheValid) {
        console.log('[' + jobId + '] Using cached evidence from job ' + cached.job_id + ' (within 24h, website unchanged)');
        evidence = cached.evidence;
        await saveEvidence(jobId, evidence).catch(err =>
          console.warn('[' + jobId + '] saveEvidence (cached) failed:', err.message)
        );
      }
    }
    if (!evidence) {
      await updateStatus(jobId, 'collecting_evidence', 'collecting_evidence').catch(() => {});
      // ── STAGE 1: PARALLEL EVIDENCE COLLECTION ────────────────────────────────
      let serperPayload  = { results: [], knowledgeGraph: null, searchText: '', kgText: '' };
      let websiteText    = '';
      let websiteSignals = {};   // ← structured ground truth from fetchWebsite
      let inferredSite   = '';
      let visibilityPos  = -1;
      const [serperSettled, webSettled] = await Promise.allSettled([
        searchSerper(name, category, city),
        website ? fetchWebsiteText(website) : Promise.resolve({ text: '', signals: {} })
      ]);
      if (serperSettled.status === 'fulfilled') {
        serperPayload = serperSettled.value;
      } else {
        console.warn('[' + jobId + '] Serper failed:', serperSettled.reason?.message);
      }
      if (webSettled.status === 'fulfilled') {
        // fetchWebsiteText now returns { text, signals }
        var webResult   = webSettled.value || {};
        websiteText     = webResult.text    || '';
        websiteSignals  = webResult.signals || {};
        // AI CRAWLER CHECK \u2014 this line was previously only embedded in the
        // scoring prompt text, never printed to logs, making it impossible to
        // actually observe from Netlify. Explicit log line now.
        if (websiteSignals.botCrawlable === null || websiteSignals.botCrawlable === undefined) {
          console.log('[' + jobId + '] AI CRAWLER CHECK: skipped (check errored or timed out \u2014 scoring proceeds without this signal)');
        } else if (websiteSignals.botEmptyShellDetected) {
          console.log('[' + jobId + '] AI CRAWLER CHECK: FAILED \u2014 empty shell detected for: ' + (websiteSignals.botEmptyShellBots || []).join(', '));
        } else if (websiteSignals.botCrawlable) {
          console.log('[' + jobId + '] AI CRAWLER CHECK: PASSED \u2014 real bot user-agents see substantive content');
        } else {
          console.log('[' + jobId + '] AI CRAWLER CHECK: all bot fetches failed (blocked or unreachable \u2014 not the same as empty-shell)');
        }
      } else {
        console.warn('[' + jobId + '] Website fetch failed:', webSettled.reason?.message);
      }
      inferredSite = inferOfficialSite(website, serperPayload, name);
      // If the primary website fetch failed, try the inferred site
      if (!websiteText && inferredSite && inferredSite !== website) {
        var fallbackResult = await fetchWebsiteText(inferredSite).catch(function() {
          return { text: '', signals: {} };
        });
        websiteText    = fallbackResult.text    || '';
        websiteSignals = fallbackResult.signals || {};
      }
      // ── WEBSITE IDENTITY CHECK ────────────────────────────────────────────────
      // If the user submitted a website that fetched successfully but belongs to
      // a completely different business (e.g. they accidentally pasted a competitor's
      // URL), the page title and H1 will share no words with the business name.
      // In that case, switch to the inferred official site derived from search results.
      if (websiteText && inferredSite) {
        var titleText   = (websiteSignals && websiteSignals.titleText) || '';
        var h1Text      = (websiteSignals && websiteSignals.h1Text)    || '';
        var pageContent = (titleText + ' ' + h1Text).toLowerCase();
        // Extract meaningful tokens from the business name (3+ chars, not numbers alone)
        var bizTokens = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
          .filter(function(w) { return w.length >= 3 && !/^\d+$/.test(w); });
        var pageMatchesName = bizTokens.length === 0 || bizTokens.some(function(tok) {
          return pageContent.indexOf(tok) !== -1;
        });
        if (!pageMatchesName) {
          console.warn('[' + jobId + '] Website identity mismatch: "' + titleText + '" does not match business "' + name + '" — switching to inferred site: ' + inferredSite);
          var correctedResult = await fetchWebsiteText(inferredSite).catch(function() {
            return { text: '', signals: {} };
          });
          if (correctedResult.text) {
            websiteText    = correctedResult.text    || '';
            websiteSignals = correctedResult.signals || {};
            console.log('[' + jobId + '] Corrected to inferred site: ' + inferredSite);
          }
        }
      }
      const targetDomain = normalizeUrl(website || '');
      if (targetDomain) {
        visibilityPos = (serperPayload.results || []).findIndex(
          r => normalizeUrl(r.link || '') === targetDomain
        );
      }
        evidence = {
        name, category, city, website, description, knownCompetitors,
        inferredOfficialSite: inferredSite   || '',
        websiteText:          websiteText    || '',
        websiteSignals:       websiteSignals,   // ← structured signals attached here
        searchText:           serperPayload.searchText   || 'No search results returned.',
        kgText:               serperPayload.kgText       || 'None',
        visibilityPosition:   visibilityPos,
        competitors:          serperPayload.competitors   || [],
        socialSignals:        serperPayload.socialSignals || {},
        summaries:            serperPayload.summaries     || {},
        collectedAt:          new Date().toISOString(),
      };
      await saveEvidence(jobId, evidence).catch(err =>
        console.warn('[' + jobId + '] saveEvidence failed:', err.message)
      );
      // ── PARALLEL EVIDENCE FETCHING ────────────────────────────────────────────
      // Social, reviews, Apify, and competitor homepage are fully independent —
      // run them concurrently with Promise.allSettled instead of sequentially.
      // Before: worst-case ~135 s (Apify alone) + social + reviews + competitor.
      // After:  wall-clock = slowest single leg, typically 15-20 s.
      var topCompDomain = (serperPayload.competitors && serperPayload.competitors.length > 0 &&
        serperPayload.competitors[0] && serperPayload.competitors[0]['domain'])
        ? serperPayload.competitors[0]['domain'] : null;
      var parallelResults = await Promise.allSettled([
        fetchSocialEvidence(serperPayload.results || [], name),       // [0]
        fetchReviewPages(serperPayload.results || []),                 // [1]
        fetchApifyEvidence(name, city, website),                       // [2]
        topCompDomain ? fetchCompetitorText(topCompDomain) : Promise.resolve(''), // [3]
        // [4] Competitor real review data — uses domain as the "name" since
        // the actual company name is not yet known at this stage. Runs in
        // parallel with [2] so no additional wall-clock cost.
        topCompDomain ? fetchApifyEvidence(topCompDomain, '', 'https://' + topCompDomain) : Promise.resolve(null) // [4]
      ]);
      // ── [0] Social media pages ────────────────────────────────────────────────
      var socialEvidence = {};
      var socialText     = 'No social media pages found.';
      if (parallelResults[0].status === 'fulfilled') {
        try {
          socialEvidence = parallelResults[0].value || {};
          socialText     = buildSocialText(socialEvidence);
          evidence['socialEvidence'] = socialEvidence;
          evidence['socialText']     = socialText;
          console.log('[' + jobId + '] Social platforms fetched:', Object.keys(socialEvidence).join(', ') || 'none');
        } catch (err) {
          console.warn('[' + jobId + '] Social processing failed:', err.message);
        }
      } else {
        console.warn('[' + jobId + '] Social fetch failed:', (parallelResults[0].reason || {}).message || parallelResults[0].reason);
      }
      // ── [1] Review platform pages ─────────────────────────────────────────────
      var reviewPages = {};
      var reviewText  = 'No review platform pages found.';
      if (parallelResults[1].status === 'fulfilled') {
        try {
          reviewPages = parallelResults[1].value || {};
          reviewText  = buildReviewText(reviewPages);
          evidence['reviewPages'] = reviewPages;
          evidence['reviewText']  = reviewText;
          var reviewKeys = Object.keys(reviewPages);
          if (reviewKeys.length > 0) {
            console.log('[' + jobId + '] Review pages fetched:', reviewKeys.join(', '));
            if (!websiteSignals.confirmedReviewPlatforms) {
              websiteSignals.confirmedReviewPlatforms = reviewKeys;
              evidence.websiteSignals = websiteSignals;
            }
          }
        } catch (err) {
          console.warn('[' + jobId + '] Review processing failed:', err.message);
        }
      } else {
        console.warn('[' + jobId + '] Review fetch failed:', (parallelResults[1].reason || {}).message || parallelResults[1].reason);
      }
      // ── [2] Apify review evidence ─────────────────────────────────────────────
      var apifyResult = { apifyText: '', trustpilot: null, googleReviews: null };
      if (parallelResults[2].status === 'fulfilled') {
        try {
          apifyResult = parallelResults[2].value || apifyResult;
          if (apifyResult.apifyText) {
            evidence['apifyText']     = apifyResult.apifyText;
            evidence['trustpilot']    = apifyResult.trustpilot;
            evidence['googleReviews'] = apifyResult.googleReviews;
            if (apifyResult.trustpilot) {
              websiteSignals.trustpilotRating      = apifyResult.trustpilot.rating      || null;
              websiteSignals.trustpilotReviewCount = apifyResult.trustpilot.reviewCount || 0;
            }
            if (apifyResult.googleReviews) {
              websiteSignals.googleRating      = apifyResult.googleReviews.rating      || null;
              websiteSignals.googleReviewCount = apifyResult.googleReviews.reviewCount || 0;
            }
            evidence.websiteSignals = websiteSignals;
            console.log('[' + jobId + '] Apify evidence collected');
          }
        } catch (err) {
          console.warn('[' + jobId + '] Apify processing failed:', err.message);
        }
      } else {
        console.warn('[' + jobId + '] Apify failed:', (parallelResults[2].reason || {}).message || parallelResults[2].reason);
      }
      // ── [3] Competitor homepage fetch ─────────────────────────────────────────
      var competitorPageText = '';
      if (parallelResults[3].status === 'fulfilled') {
        try {
          competitorPageText = parallelResults[3].value || '';
          if (competitorPageText && topCompDomain) {
            evidence['competitorPageText'] = competitorPageText;
            evidence['competitorDomain']   = topCompDomain;
            console.log('[' + jobId + '] Fetched competitor: ' + topCompDomain);
          }
        } catch (err) {
          console.warn('[' + jobId + '] Competitor homepage processing failed:', err.message);
        }
      } else {
        console.warn('[' + jobId + '] Competitor homepage fetch failed:', (parallelResults[3].reason || {}).message || parallelResults[3].reason);
      }
      // ── [4] Competitor real review data (Apify) ───────────────────────────────
      if (parallelResults[4] && parallelResults[4].status === 'fulfilled' && parallelResults[4].value) {
        try {
          var compApify = parallelResults[4].value;
          if (compApify && (compApify.trustpilot || compApify.googleReviews)) {
            evidence['competitorApify'] = {
              trustpilot:   compApify.trustpilot   || null,
              googleReviews: compApify.googleReviews || null
            };
            console.log('[' + jobId + '] Competitor Apify data collected for: ' + topCompDomain);
          }
        } catch (err) {
          console.warn('[' + jobId + '] Competitor Apify processing failed:', err.message);
        }
      }
      // ── STAGE 1b: CATEGORY INFERENCE + SECOND-PASS COMPETITOR SEARCH ─────────
      var inferredCat = category;
      try {
        var catResult = await inferCategory(name, category, evidence['websiteText'], evidence['searchText']);
        // Trust the inference when the website was actually fetched (substantial text =
        // the model grounded on real evidence). Only revert to the user-typed category
        // when the website is missing or very thin — in that case, the inference has
        // little to go on and the user's own words are the best available signal.
        var websiteIsSubstantial = (evidence['websiteText'] || '').length > 300;
        if (catResult && !websiteIsSubstantial && !categoryFaithful(category, catResult)) {
          console.warn('[' + jobId + '] Inferred category "' + catResult + '" reverted to owner category "' + category + '" (thin website evidence)');
          catResult = category;
        } else if (catResult && !categoryFaithful(category, catResult)) {
          console.log('[' + jobId + '] Inferred category "' + catResult + '" differs from owner category "' + category + '" — trusting website evidence');
        }
        if (catResult) {
          inferredCat = catResult;
          if (catResult !== category) {
            console.log('[' + jobId + '] Inferred category: ' + inferredCat);
          }
          evidence['inferredCategory'] = inferredCat;
        }
      } catch (err) {
        console.warn('[' + jobId + '] Category inference failed:', err.message);
      }
      try {
        var compSearch = await searchCompetitors(name, inferredCat, city, knownCompetitors);
        if (compSearch.competitors && compSearch.competitors.length > 0) {
          var existingDomains = (evidence['competitors'] || []).map(function(c) { return c['domain']; });
          var newComps = compSearch.competitors.filter(function(c) { return existingDomains.indexOf(c['domain']) === -1; });
          evidence['competitors'] = newComps.concat(evidence['competitors'] || []).slice(0, 5);
          console.log('[' + jobId + '] Second-pass competitors:', evidence['competitors'].map(function(c) { return c['domain']; }).join(', '));
        }
        if (compSearch.searchText) {
          evidence['searchText'] = evidence['searchText'] + '\n\nSECOND-PASS COMPETITOR SEARCH (inferred category: ' + inferredCat + '):\n' + compSearch.searchText;
        }
      } catch (err) {
        console.warn('[' + jobId + '] Second-pass competitor search failed:', err.message);
      }

      // ── STAGE 1c: AI SELECTION GROUND TRUTH (before-simulation) ───────────
      // Runs the three real "who would you recommend" queries BEFORE scoring,
      // so the dominant competitor is chosen from what AI actually recommends
      // today — not from whoever happens to SEO-rank in search evidence.
      // Saved inside evidence so it caches with the fingerprint: competitor
      // identity stays stable across runs within the cache window.
      var cachedSimLang = evidence['aiSimulationBefore'] && evidence['aiSimulationBefore'].before
        && evidence['aiSimulationBefore'].before.language;
      if (!evidence['aiSimulationBefore'] || (languagePref && cachedSimLang !== languagePref)) {
        try {
          var simBefore = await runBeforeSimulation({
            language:          languagePref || undefined,
            name:              name,
            category:          category,
            city:              city,
            description:       description,
            inferredCategory:  evidence['inferredCategory'] || category,
            // Rich context — lets the query generator understand the real
            // business from evidence, not just the user-typed category.
            // website title + H1 are the most signal-dense part of websiteText.
            websiteContext:    (
              ((websiteSignals && websiteSignals.titleText) ? 'Title: ' + websiteSignals.titleText + '\n' : '') +
              ((websiteSignals && websiteSignals.h1Text)    ? 'H1: '    + websiteSignals.h1Text    + '\n' : '') +
              (websiteText ? websiteText.slice(0, 900) : '')
            ).trim(),
            kgText:            evidence['kgText'] || '',
            competitorDomains: (evidence['competitors'] || [])
              .map(function(c) { return c.domain || c.name || ''; })
              .filter(Boolean),
            knownCompetitors:  knownCompetitors || ''
          });
          if (simBefore && simBefore.before) {
            evidence['aiSimulationBefore'] = simBefore;
            console.log('[' + jobId + '] Before-simulation: appeared ' + simBefore.before.appearedCount + '/3');
            var directCompetitorCheck = null;
            try {
              directCompetitorCheck = await runDirectCompetitorQuestion({
                language: simBefore.before.language,
                name: name,
                category: category,
                city: city,
                description: description,
                inferredCategory: evidence['inferredCategory'] || category
              }, true);
              evidence['directCompetitorCheck'] = directCompetitorCheck;
            } catch (directErr) {
              console.warn('[' + jobId + '] Direct competitor question failed:', directErr.message);
            }
            var sharedPlatformQueries = (simBefore.before.results || []).concat(
              directCompetitorCheck && Array.isArray(directCompetitorCheck.results)
                ? directCompetitorCheck.results
                : []
            );
            // Measure OpenAI against the exact same localized buyer questions.
            // Results remain platform-separated; Claude stays the existing
            // scoring authority until a true cross-platform aggregation rule is
            // introduced and validated.
            try {
              var openaiSimulation = await runOpenAISimulation({
                name: name,
                category: evidence['inferredCategory'] || category,
                city: city,
                language: simBefore.before.language,
                sourceResults: sharedPlatformQueries
              });
              evidence['platformSimulations'] = evidence['platformSimulations'] || {};
              evidence['platformSimulations']['claude'] = {
                available: true,
                provider: 'anthropic',
                language: simBefore.before.language,
                appearedCount: simBefore.before.appearedCount,
                totalQueries: simBefore.before.totalQueries,
                results: sharedPlatformQueries
              };
              evidence['platformSimulations']['openai'] = openaiSimulation;
              console.log('[' + jobId + '] OpenAI simulation: ' + (openaiSimulation.available ? 'completed' : 'unavailable'));
            } catch (openaiErr) {
              console.warn('[' + jobId + '] OpenAI simulation failed:', openaiErr.message);
              evidence['platformSimulations'] = evidence['platformSimulations'] || {};
              evidence['platformSimulations']['openai'] = {
                available: false,
                provider: 'openai',
                reason: openaiErr.message || 'OpenAI simulation failed'
              };
            }
            // ── COMPETITOR FREQUENCY — derive competitorDecision from AI ground truth
            // Count how many simulation responses mention each known competitor.
            // The most-mentioned non-platform name becomes realCompetitor, which
            // the enforcement block at lines 509-519 uses to lock the final result.
            // This is what was previously "dead code" — the enforcement code was
            // always ready but evidence.competitorDecision was never populated.
            try {
              var allSimResponses = [];
              var allSimResponsesOrig = []; // original-cased for name extraction
              var simResponseGroups = []; // one group per distinct buyer-intent query
              var allSimQueryTexts = []; // query texts — terms here describe the category, not competitors
              sharedPlatformQueries.forEach(function(r) {
                if (r.query) allSimQueryTexts.push(String(r.query).toLowerCase());
                var responseGroup = (r.allResponses || []).filter(Boolean);
                simResponseGroups.push(responseGroup);
                responseGroup.forEach(function(txt) {
                  if (txt) {
                    allSimResponses.push(txt.toLowerCase());
                    allSimResponsesOrig.push(txt);
                  }
                });
              });
              if (allSimResponses.length > 0) {
                // Build candidate list from Serper competitors + knownCompetitors input.
                // Serper competitor objects use the field "domain" (not "name") — e.g.
                // { domain: "doncarne.de", title: "Don Carne | Premium Beef", ... }
                // c.name was always undefined here, silently emptying the entire Serper
                // candidate pool. Use domain as the identifier; the needle-building step
                // below strips the TLD so "doncarne.de" matches AI responses saying "Don Carne".
                var compCandidates = (evidence['competitors'] || []).map(function(c) {
                  return c && (c.name || c.domain || '');
                }).filter(Boolean);
                var kcNames = String(evidence['knownCompetitors'] || knownCompetitors || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                var allCandidates = compCandidates.concat(kcNames);
                // Deduplicate by normalized key; exclude platforms, generics, and the subject itself
                var normSelf = name.toLowerCase().replace(/[^a-z0-9]/g, '');
                var seenKeys = {};
                var uniqueCandidates = allCandidates.filter(function(n) {
                  if (!n) return false;
                  var key = n.toLowerCase().replace(/[^a-z0-9]/g, '');
                  if (key === normSelf) return false;
                  if (isPlatformName(n) || isGenericEntity(n) || isGenericPhrase(n)) return false;
                  if (seenKeys[key]) return false;
                  seenKeys[key] = true;
                  return true;
                });
                // ── DIRECT CLAUDE EXTRACTION ──────────────────────────────────────────
                // Ask Claude to read its own simulation response texts and identify which
                // specific business names it recommended. This eliminates regex noise
                // (category terms like "Black Angus Rinder", boilerplate like "Beide Optionen")
                // by using language understanding instead of pattern matching.
                // Serper domain candidates are passed as hints.
                // Falls back to frequency counting if the API call fails.
                var extractedCompetitors = null;
                if (allSimResponsesOrig.length > 0) {
                  try {
                    var hintList = uniqueCandidates.slice(0, 12).map(function(c) {
                      // Strip TLD for cleaner display (doncarne.de → doncarne.de shown as-is; scoring strips it)
                      return c;
                    }).join(', ');
                    // Read every recorded sample. Limiting this to six silently
                    // dropped some buyer questions when each query had four runs.
                    var responseSnippets = allSimResponsesOrig.map(function(r, i) {
                      return 'Response ' + (i + 1) + ':\n' + String(r).slice(0, 700);
                    }).join('\n\n');
                    var inferredCatForPrompt = evidence['inferredCategory'] || category || '';
                    var extractPrompt =
                      'TASK: From the AI recommendation responses below, identify the real business names being recommended as competitors to the subject business.\n\n'
                      + 'SUBJECT BUSINESS (exclude this from results): ' + name + '\n'
                      + 'SUBJECT CATEGORY: ' + inferredCatForPrompt + '\n'
                      + (city ? 'SUBJECT MARKET / LOCATION: ' + city + '\n' : '')
                      + '\n'
                      + 'KNOWN COMPETITORS (company names or domains — prioritise these if they appear in responses):\n'
                      + (hintList || 'none') + '\n\n'
                      + 'AI SIMULATION RESPONSES:\n---\n'
                      + responseSnippets
                      + '\n---\n\n'
                      + 'RULES:\n'
                      + '1. Extract ONLY real business/brand names that AI is actively recommending.\n'
                      + '2. EXCLUDE: the subject business (' + name + '), generic category terms, descriptive phrases (e.g. "Beide Optionen", "Both Options", "Black Angus Rinder"), platform names (Google, Amazon, Trustpilot), adjectives, and section headings.\n'
                      + '3. CRITICAL — SAME ROLE IN THE TRANSACTION: A true competitor is a company a buyer would put on the SAME SHORTLIST for the SAME purchasing decision. Apply three tests: (a) Does this company sell the same TYPE of product or service? (b) To the same TYPE of buyer? (c) Under the same COMMERCIAL MODEL — e.g. both license software, both sell direct, both offer managed services? If any test fails, it is not a true competitor — it may be a customer, a supplier, or a company in an adjacent market. A company that buys or uses the product type is a CUSTOMER. A company that distributes content operates in a different market from one that sells the software to display it. A company that outsources operations is in a different procurement category from one that licenses software.\n'                      + '4b. ROLE DISAMBIGUATION: When an AI response names a company prominently, identify its ROLE before treating it as a competitor. Is it a SELLER of the same product (competitor), a BUYER of the product (customer), or a company in a different part of the value chain (supplier, distributor, infrastructure)? Only sellers of the same product to the same buyer under the same model qualify. Prominence in an AI answer does not make something a competitor — what matters is whether a real buyer would choose it instead of the subject for the same need.\n'
                      + '4. CRITICAL — SAME SERVICEABLE MARKET: The competitor must actually sell to or operate in the subject\'s market. A US-only brand is not the competitor of a Germany-only business. A global B2B platform can compete globally. A local service competes locally. If uncertain whether a competitor reaches the subject\'s market, exclude it.\n'
                      + '5. KNOWN COMPETITORS FIRST: If a known competitor name or domain appears anywhere in the responses (even once), prioritise it over unknown names with higher mention counts — it is the most reliable signal.\n'
                      + '6. Rank by category relevance first, then by mention count. The most directly competing business goes in "first".\n'
                      + '7. If a known domain hint matches a name in the text (e.g. "doncarne.de" → "Don Carne"), use the clean business name form.\n'
                      + '7b. IDENTITY ACCURACY: preserve the company\'s exact public brand name. Never shorten, translate, or invent a domain. If a response is visibly truncated but an exact known domain hint completes the identity, use that exact known identity rather than guessing a shorter domain.\n'
                      + '8. If no real same-category, same-market competitor appears, use empty string.\n\n'
                      + 'Return ONLY this JSON (no markdown, no explanation):\n'
                      + '{"first":"BusinessName","second":"BusinessName","firstCount":3,"secondCount":2}';

                    var extractController = new AbortController();
                    var extractTimer = setTimeout(function() { extractController.abort(); }, 15000);
                    var extractResp = await fetch('https://api.anthropic.com/v1/messages', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                      },
                      body: JSON.stringify({
                        model: 'claude-sonnet-4-6',
                        max_tokens: 120,
                        temperature: 0,
                        messages: [{ role: 'user', content: extractPrompt }]
                      }),
                      signal: extractController.signal
                    });
                    clearTimeout(extractTimer);
                    if (extractResp.ok) {
                      var extractData = await extractResp.json();
                      var extractText = (extractData.content || [])
                        .filter(function(b) { return b.type === 'text'; })
                        .map(function(b) { return b.text || ''; }).join('').trim();
                      var extractClean = extractText.replace(/```json|```/g, '').trim();
                      var extractParsed = JSON.parse(extractClean);
                      if (extractParsed && typeof extractParsed === 'object') {
                        var f = String(extractParsed.first  || '').trim();
                        var s = String(extractParsed.second || '').trim();
                        extractedCompetitors = {
                          first:        f || null,
                          second:       s || null,
                          firstCount:   Number(extractParsed.firstCount)  || 0,
                          secondCount:  Number(extractParsed.secondCount) || 0
                        };
                        console.log('[' + jobId + '] Direct extraction result: first="' + f + '" (' + (extractParsed.firstCount || 0) + ') second="' + s + '" (' + (extractParsed.secondCount || 0) + ')');
                      }
                    } else {
                      console.warn('[' + jobId + '] Direct extraction API error: ' + extractResp.status);
                    }
                  } catch (extractErr) {
                    console.warn('[' + jobId + '] Direct extraction failed, will use frequency fallback:', extractErr.message);
                  }
                }

                // ── SET competitorDecision ─────────────────────────────────────────────
                if (extractedCompetitors && extractedCompetitors.first) {
                  // Claude identifies names; JavaScript verifies frequency from the
                  // actual transcripts. Never trust model-supplied counts.
                  var countExactMentions = function(candidate) {
                    var normalizedCandidate = String(candidate || '').toLowerCase()
                      .replace(/\b(gmbh|ag|kg|ug|inc|llc|ltd|co|company)\b/g, ' ')
                      .replace(/[^a-z0-9]+/g, ' ').trim();
                    if (!normalizedCandidate) return 0;
                    return allSimResponses.filter(function(response) {
                      var normalizedResponse = String(response || '').replace(/[^a-z0-9]+/g, ' ').trim();
                      return (' ' + normalizedResponse + ' ').indexOf(' ' + normalizedCandidate + ' ') !== -1;
                    }).length;
                  };
                  var countDistinctQueries = function(candidate) {
                    var normalizedCandidate = String(candidate || '').toLowerCase()
                      .replace(/\b(gmbh|ag|kg|ug|inc|llc|ltd|co|company)\b/g, ' ')
                      .replace(/[^a-z0-9]+/g, ' ').trim();
                    if (!normalizedCandidate) return 0;
                    return simResponseGroups.filter(function(group) {
                      return group.some(function(response) {
                        var normalizedResponse = String(response || '').toLowerCase()
                          .replace(/[^a-z0-9]+/g, ' ').trim();
                        return (' ' + normalizedResponse + ' ').indexOf(' ' + normalizedCandidate + ' ') !== -1;
                      });
                    }).length;
                  };
                  var verifiedFirstCount = countExactMentions(extractedCompetitors.first);
                  var verifiedSecondCount = countExactMentions(extractedCompetitors.second);
                  var verifiedFirstQueryCount = countDistinctQueries(extractedCompetitors.first);
                  var verifiedSecondQueryCount = countDistinctQueries(extractedCompetitors.second);
                  var verifiedFirst = verifiedFirstQueryCount >= 2 ? extractedCompetitors.first : null;
                  var verifiedSecond = verifiedSecondQueryCount >= 2 ? extractedCompetitors.second : null;
                  evidence['competitorDecision'] = {
                    realCompetitor:     null,
                    aiRecommends:       verifiedFirst,
                    secondAiCompetitor: verifiedSecond,
                    source:             'ai-direct-extraction',
                    selectionVersion:   4,
                    mentionCount:       verifiedFirstCount,
                    secondMentionCount: verifiedSecondCount,
                    distinctQueryCount: verifiedFirstQueryCount,
                    secondDistinctQueryCount: verifiedSecondQueryCount,
                    aiMentionedCompetitor: verifiedFirstCount > 0 ? extractedCompetitors.first : null,
                    secondAiMentionedCompetitor: verifiedSecondCount > 0 ? extractedCompetitors.second : null,
                    aiMentionedCount: verifiedFirstCount,
                    secondAiMentionedCount: verifiedSecondCount,
                    aiMentionedQueryCount: verifiedFirstQueryCount,
                    secondAiMentionedQueryCount: verifiedSecondQueryCount,
                    totalResponses:     allSimResponses.length,
                    totalQueries:       simResponseGroups.length,
                    categoryUnowned:    !verifiedFirst
                  };
                  console.log('[' + jobId + '] competitorDecision (verified): ' + (verifiedFirst || 'no consistent leader') + ' (' + verifiedFirstCount + '/' + allSimResponses.length + ' samples, ' + verifiedFirstQueryCount + '/' + simResponseGroups.length + ' queries)' + (verifiedSecond ? ' | second: ' + verifiedSecond + ' (' + verifiedSecondQueryCount + ' queries)' : ''));
                } else {
                  // Fallback: frequency count mentions of Serper/known candidates across responses
                  console.log('[' + jobId + '] Direct extraction returned no names — using frequency fallback on ' + uniqueCandidates.length + ' candidates');
                  var bestName = null, bestCount = 0;
                  var secondName = null, secondCount = 0;
                  uniqueCandidates.forEach(function(n) {
                    // Strip domain TLD so "gourmetfleisch.de" → needle "gourmetfleisch"
                    // matches AI response that says "Gourmetfleisch".
                    var forNeedle = n.replace(/\.[a-z]{2,4}(\s|\/|$)/i, ' ').replace(/\.[a-z]{2,4}$/, '');
                    var needle = forNeedle.toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (!needle) return;
                    var cnt = allSimResponses.filter(function(r) {
                      return r.replace(/[^a-z0-9]/g, '').indexOf(needle) !== -1;
                    }).length;
                    if (cnt > bestCount) {
                      secondName = bestName; secondCount = bestCount;
                      bestName = n; bestCount = cnt;
                    } else if (cnt > 0 && cnt > secondCount) {
                      secondName = n; secondCount = cnt;
                    }
                  });
                  var fallbackQueryCount = function(candidate) {
                    var forNeedle = String(candidate || '').replace(/\.[a-z]{2,4}(\s|\/|$)/i, ' ').replace(/\.[a-z]{2,4}$/, '');
                    var needle = forNeedle.toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (!needle) return 0;
                    return simResponseGroups.filter(function(group) {
                      return group.some(function(response) {
                        return String(response || '').toLowerCase().replace(/[^a-z0-9]/g, '').indexOf(needle) !== -1;
                      });
                    }).length;
                  };
                  var bestQueryCount = fallbackQueryCount(bestName);
                  var secondQueryCount = fallbackQueryCount(secondName);
                  evidence['competitorDecision'] = {
                    realCompetitor:     null,
                    aiRecommends:       null,
                    secondAiCompetitor: null,
                    source:             'ai-ground-truth',
                    selectionVersion:   3,
                    mentionCount:       bestCount,
                    totalResponses:     allSimResponses.length,
                    distinctQueryCount: bestQueryCount,
                    secondMentionCount: secondCount,
                    secondDistinctQueryCount: secondQueryCount,
                    aiMentionedCompetitor: bestCount > 0 ? bestName : null,
                    secondAiMentionedCompetitor: secondCount > 0 ? secondName : null,
                    aiMentionedCount: bestCount,
                    secondAiMentionedCount: secondCount,
                    aiMentionedQueryCount: bestQueryCount,
                    secondAiMentionedQueryCount: secondQueryCount,
                    totalQueries:       simResponseGroups.length,
                    categoryUnowned:    true
                  };
                  console.log('[' + jobId + '] competitorDecision (fallback): ' +
                    (bestName ? bestName + ' (' + bestCount + '/' + allSimResponses.length + ' responses)' : 'no named competitor found — categoryUnowned') +
                    (secondName ? ' | second: ' + secondName + ' (' + secondCount + ')' : ''));
                }
              }
            } catch (freqErr) {
              console.warn('[' + jobId + '] Competitor frequency count failed:', freqErr.message);
            }
          }
        } catch (err) {
          console.warn('[' + jobId + '] Before-simulation failed:', err.message);
        }
      }

      // ── FINAL EVIDENCE SAVE — persist the fully enriched evidence ───────────
      // The early save above stores only the initial Serper + website snapshot.
      // Everything collected after it (social, review pages, Apify, competitor
      // homepage, inferred category, second-pass competitors) must be in the
      // saved copy — otherwise cached runs within 24h score with LESS evidence
      // than fresh runs, producing inconsistent scores and fewer competitors.
      await saveEvidence(jobId, evidence).catch(err =>
        console.warn('[' + jobId + '] saveEvidence (final) failed:', err.message)
      );

    }

    // Cached evidence created before the OpenAI integration already contains
    // valid Claude buyer queries. Backfill only the missing OpenAI measurement
    // instead of forcing a full evidence refresh.
    try {
      var cachedBeforeForOpenAI = evidence['aiSimulationBefore'] && evidence['aiSimulationBefore'].before;
      var cachedOpenAI = evidence['platformSimulations'] && evidence['platformSimulations']['openai'];
      if (process.env.OPENAI_API_KEY && cachedBeforeForOpenAI && (!cachedOpenAI || !cachedOpenAI.available)) {
        var cachedOpenAIResult = await runOpenAISimulation({
          name: name,
          category: evidence['inferredCategory'] || category,
          city: city,
          language: cachedBeforeForOpenAI.language,
          sourceResults: (cachedBeforeForOpenAI.results || []).concat(
            evidence['directCompetitorCheck'] && Array.isArray(evidence['directCompetitorCheck'].results)
              ? evidence['directCompetitorCheck'].results
              : []
          )
        });
        evidence['platformSimulations'] = evidence['platformSimulations'] || {};
        evidence['platformSimulations']['claude'] = evidence['platformSimulations']['claude'] || {
          available: true,
          provider: 'anthropic',
          language: cachedBeforeForOpenAI.language,
          appearedCount: cachedBeforeForOpenAI.appearedCount,
          totalQueries: cachedBeforeForOpenAI.totalQueries,
          results: (cachedBeforeForOpenAI.results || []).concat(
            evidence['directCompetitorCheck'] && Array.isArray(evidence['directCompetitorCheck'].results)
              ? evidence['directCompetitorCheck'].results
              : []
          )
        };
        evidence['platformSimulations']['openai'] = cachedOpenAIResult;
        await saveEvidence(jobId, evidence).catch(function(err) {
          console.warn('[' + jobId + '] OpenAI cache backfill save failed:', err.message);
        });
      }
    } catch (openaiBackfillErr) {
      console.warn('[' + jobId + '] OpenAI cache backfill failed:', openaiBackfillErr.message);
    }

    // ── COMPETITOR STABILITY — look up previously identified competitor ────────
    // This prevents drift between runs (e.g. Semrush one day, Profound the next)
    // by giving Claude a strong prior anchored to the last verified run.
    try {
      var previousCompetitor = await getPreviousCompetitor(fingerprint);
      if (previousCompetitor) {
        evidence['previousCompetitor'] = previousCompetitor;
        console.log('[' + jobId + '] Previous competitor: ' + previousCompetitor);
      }
    } catch (err) {
      console.warn('[' + jobId + '] Previous competitor lookup failed:', err.message);
    }

    // Declared rivals from the subject's own site → owner-named priority.
    try {
      var declared = extractDeclaredCompetitors(evidence['websiteText'], name);
      if (declared.length) {
        console.log('[' + jobId + '] Website-declared competitors: ' + declared.join(', '));
        var kc = String(evidence['knownCompetitors'] || knownCompetitors || '').trim();
        var kcLc = kc.toLowerCase();
        var additions = declared.filter(function(d) { return kcLc.indexOf(d.toLowerCase()) === -1; });
        if (additions.length) {
          evidence['knownCompetitors'] = (kc ? kc + ', ' : '') + additions.join(', ');
        }
        evidence['declaredCompetitors'] = declared;
      }
    } catch (e) {
      console.warn('[' + jobId + '] Declared-competitor extraction failed:', e.message);
    }

    // ── DUAL-ARENA DETECTION ──────────────────────────────────────────────────
    // Detects whether this business competes in two genuinely separate decision
    // frames — a specialty-product arena (brand, breed, origin) AND an online
    // channel arena (ordering experience, delivery trust). Purely code-based,
    // no AI call. Result stored on evidence so it survives the cache and is
    // visible to the scoring and display stages.
    try {
      var dualArenaResult = detectDualArena(
        evidence['websiteText'] || '',
        evidence['inferredCategory'] || category,
        description
      );
      evidence['dualArena'] = dualArenaResult;
      if (dualArenaResult.dualArena) {
        console.log('[' + jobId + '] Dual-arena detected: ' +
          dualArenaResult.arenas.map(function(a) { return a.label; }).join(' + '));

        // ── ONLINE CHANNEL COMPETITOR SEARCH ───────────────────────────────────
        // Run a second targeted search ("buy [product] online [market]") to find
        // the established DTC/e-commerce player — a different question from the
        // brand competitor search that runs inside selectDominantCompetitor.
        try {
          var productType = evidence['inferredCategory'] || category;
          var market      = city;
          console.log('[' + jobId + '] Searching online channel competitors for: ' + productType + ' / ' + market);
          var channelSearchResults = await searchOnlineChannelCompetitor(productType, market);
          console.log('[' + jobId + '] Channel search found ' + (channelSearchResults.competitors || []).length + ' candidates');

          var channelCompetitor = await selectChannelCompetitor(evidence, channelSearchResults);
          if (channelCompetitor && channelCompetitor.name) {
            evidence['onlineCompetitor'] = channelCompetitor;
            console.log('[' + jobId + '] Online channel competitor: ' + channelCompetitor.name + ' — ' + channelCompetitor.reason);
          } else {
            console.log('[' + jobId + '] No online channel competitor identified — dual-arena display will show brand arena only');
          }
        } catch (chErr) {
          console.warn('[' + jobId + '] Online channel competitor search failed (non-critical):', chErr.message);
        }

      } else {
        console.log('[' + jobId + '] Single-arena business (standard flow)');
      }
    } catch (err) {
      console.warn('[' + jobId + '] Dual-arena detection failed (non-critical):', err.message);
      evidence['dualArena'] = { dualArena: false };
    }

    // ── STAGE 2: SCORING ──────────────────────────────────────────────────────
    await updateStatus(jobId, 'scoring', 'scoring').catch(() => {});
    let rawOutput;
    try {
      rawOutput = await scoreWithClaude(evidence);
    } catch (err) {
      console.error('[' + jobId + '] Claude scoring failed:', err.message);
      await saveError(jobId, 'Scoring failed: ' + err.message).catch(() => {});
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: false, jobId }) };
    }
    if (!hasValidShape(rawOutput)) {
      console.warn('[' + jobId + '] Claude output shape invalid — applying safe normalization');
    }
    const finalResult = buildSafeOutput(rawOutput);
    // ── V5 COMPETITOR CONFIRMATION ─────────────────────────────────────────────────────
    // scoreWithClaude calls selectDominantCompetitor v5 which writes directly to
    // evidence.competitorDecision (JS object passed by reference). After scoreWithClaude
    // returns, evidence.competitorDecision already holds the v5 web-search result.
    // No promotion needed — just log the active decision for debugging.
    try {
      var cd5 = evidence['competitorDecision'];
      if (cd5 && cd5.selectionVersion === 5) {
        console.log('[' + jobId + '] V5 active: ' + (cd5.realCompetitor || 'none')
          + (cd5.secondAiCompetitor ? ' | second: ' + cd5.secondAiCompetitor : '')
          + (cd5.globalBenchmark ? ' | benchmark: ' + cd5.globalBenchmark : ''));
      } else if (cd5) {
        console.log('[' + jobId + '] V5 did not run — using v' + (cd5.selectionVersion || '?')
          + ': ' + (cd5.realCompetitor || 'none'));
      }
    } catch (v5Err) {
      console.warn('[' + jobId + '] V5 check failed:', v5Err.message);
    }


    // ── COMPETITOR ENFORCEMENT (code-level) ───────────────────────────
    // The dedicated selection stage's decision is final. If the scoring model
    // ignored the directive, this overwrites the result — a prompt can be
    // disobeyed; an assignment cannot. Survives poisoned caches and priors.
    try {
      var cd = evidence['competitorDecision'];
      if (cd && cd.realCompetitor) {
        if (!Array.isArray(finalResult.competitors)) finalResult.competitors = [];
        var comps = finalResult.competitors;
        var normName = function(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
        var target = normName(cd.realCompetitor);
        var idx = comps.findIndex(function(c) { return c && normName(c.name) === target; });
        if (idx === 0) {
          // scoring model obeyed — nothing to do
        } else if (idx > 0) {
          var entry = comps.splice(idx, 1)[0];
          comps.unshift(entry);
          console.warn('[' + jobId + '] Competitor enforcement: promoted ' + cd.realCompetitor + ' from position ' + idx);
        } else {
          comps.unshift({
            name:         cd.realCompetitor,
            advantage:    cd.reason || 'Direct head-to-head competitor in this category.',
            gapLocation:  '',
            closeGap:     '',
            evidence:     'Identified by the dedicated competitor-selection stage (source: ' + cd.source + ').'
              + (cd.categoryUnowned ? ' AI answers for this category currently name no true same-category player — the category answer is unowned.' : ''),
            queryContext: cd.source
          });
          console.warn('[' + jobId + '] Competitor enforcement: inserted ' + cd.realCompetitor + ' (scoring model had ignored the decision)');
        }
        // who AI actually names — ensure it is present as displacement evidence
        if (cd.aiRecommends && normName(cd.aiRecommends) !== target) {
          var hasAI = comps.some(function(c) { return c && normName(c.name) === normName(cd.aiRecommends); });
          if (!hasAI) {
            comps.splice(1, 0, {
              name:         cd.aiRecommends,
              advantage:    'This is the business AI currently recommends when buyers ask for this category.',
              gapLocation:  '',
              closeGap:     '',
              evidence:     'Named in the AI selection ground truth — the real recommendation queries run for this diagnostic.',
              queryContext: 'ai-ground-truth'
            });
          }
        }
        // Preserve useful buyer-choice alternatives even when they appeared in
        // only one distinct query. They are not promoted to recommendation
        // leader; the label and coverage make their narrower evidence explicit.
        var altInsertAt = (cd.aiRecommends && normName(cd.aiRecommends) !== target) ? 2 : 1;
        [
          { name: cd.aiMentionedCompetitor, count: cd.aiMentionedCount, queries: cd.aiMentionedQueryCount },
          { name: cd.secondAiMentionedCompetitor, count: cd.secondAiMentionedCount, queries: cd.secondAiMentionedQueryCount }
        ].forEach(function(alt) {
          if (!alt.name || normName(alt.name) === target || normName(alt.name) === normName(cd.aiRecommends)) return;
          var hasAlt = comps.some(function(c) { return c && normName(c.name) === normName(alt.name); });
          if (!hasAlt) {
            comps.splice(altInsertAt, 0, {
              name: alt.name,
              advantage: 'Named by Claude for a specific buyer question in this diagnostic.',
              gapLocation: '',
              closeGap: '',
              evidence: 'Appeared in ' + Number(alt.queries || 0) + ' of ' + Number(cd.totalQueries || 0) + ' buyer questions (' + Number(alt.count || 0) + ' recorded samples). This is a query-specific purchasing alternative, not the consistent overall AI leader.',
              queryContext: 'ai-query-alternative'
            });
            altInsertAt += 1;
          }
        });
      }
      // Trim moved to after second-competitor merge so all sources are included before slicing
    } catch (err) {
      console.warn('[' + jobId + '] Competitor enforcement failed:', err.message);
    }
    // DETERMINISTIC VALIDATION: the head-to-head slot may never hold a
    // platform. Rejected or empty → owner-typed → website-declared → null.
    try {
      var cdV = evidence['competitorDecision'];
      if (cdV) {
        // An unowned category can never simultaneously carry a displacer name.
        if (cdV.categoryUnowned === true && cdV.aiRecommends) {
          console.warn('[' + jobId + '] [competitor-validation] categoryUnowned yet aiRecommends "' + cdV.aiRecommends + '" — contradiction; clearing the banner name');
          cdV.aiRecommends = null;
          if (finalResult['competitorDecision']) finalResult['competitorDecision'].aiRecommends = null;
        }
        // A platform in the AI-answer slot means AI named a venue, not a rival:
        // the truthful reading is that the category answer is UNOWNED.
        if (cdV.aiRecommends && (isPlatformName(cdV.aiRecommends) || isGenericEntity(cdV.aiRecommends))) {
          var wasPlatform = isPlatformName(cdV.aiRecommends);
          console.warn('[' + jobId + '] [competitor-validation] aiRecommends "' + cdV.aiRecommends + '" is not a real named entity — clearing' + (wasPlatform ? '; treating category as unowned' : ''));
          cdV.aiRecommends = null;
          if (wasPlatform) cdV.categoryUnowned = true;
          if (finalResult['competitorDecision']) {
            finalResult['competitorDecision'].aiRecommends = null;
            if (wasPlatform) finalResult['competitorDecision'].categoryUnowned = true;
          }
        }
        // Dead code removed: the isPlatformName check above (line 776) already
        // clears cdV.aiRecommends, so a second isPlatformName check here could
        // never fire. categoryUnowned is now set inside the line-776 block.
        var ownerFirstEarly = String(knownCompetitors || '').split(',')[0].trim();
        var declaredFirst = (evidence['declaredCompetitors'] || [])[0] || '';
        if (cdV.aiRecommends && isGenericPhrase(cdV.aiRecommends)) {
          console.warn('[' + jobId + '] [competitor-validation] aiRecommends "' + cdV.aiRecommends + '" is a generic category phrase, not a named company — clearing');
          cdV.aiRecommends = null;
          if (finalResult['competitorDecision']) finalResult['competitorDecision'].aiRecommends = null;
        }
        if (cdV.realCompetitor && isGenericPhrase(cdV.realCompetitor)) {
          var repG = (ownerFirstEarly && !isGenericPhrase(ownerFirstEarly) && ownerFirstEarly) || null;
          console.warn('[' + jobId + '] [competitor-validation] realCompetitor "' + cdV.realCompetitor + '" is a generic category phrase — replaced with ' + (repG || 'null'));
          cdV.realCompetitor = repG;
        }
        if (cdV.realCompetitor && (isPlatformName(cdV.realCompetitor) || isGenericEntity(cdV.realCompetitor))) {
          var replacement = (ownerFirstEarly && !isPlatformName(ownerFirstEarly) && ownerFirstEarly) || (declaredFirst && !isPlatformName(declaredFirst) && declaredFirst) || null;
          console.warn('[' + jobId + '] [competitor-validation] "' + cdV.realCompetitor + '" is a platform, not a rival — replaced with ' + (replacement || 'null'));
          cdV.realCompetitor = replacement;
          if (Array.isArray(finalResult['competitors']) && replacement) {
            var normV = function(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
            var already = finalResult['competitors'].some(function(cc) { return normV(cc && cc.name) === normV(replacement); });
            if (!already) {
              finalResult['competitors'].unshift({ name: replacement, queryContext: 'head-to-head', why: 'Named by the business itself as its direct comparison.' });
            } else {
              finalResult['competitors'].sort(function(a, b) { return (normV(b.name) === normV(replacement)) - (normV(a.name) === normV(replacement)); });
            }
          }
        }
      }
      // Platform cards never render as competitors, whichever slot wrote them.
      if (Array.isArray(finalResult['competitors'])) {
        var beforeN = finalResult['competitors'].length;
        finalResult['competitors'] = finalResult['competitors'].filter(function(cc) { return !(cc && isPlatformName(cc.name)); });
        if (finalResult['competitors'].length !== beforeN) {
          console.warn('[' + jobId + '] [competitor-validation] purged ' + (beforeN - finalResult['competitors'].length) + ' platform card(s) from the competitor list');
        }
      }
      // A single query may surface a useful candidate, but it is not a
      // consistent recommendation leader. Remove cards whose only basis is
      // unverified displacement; retain the researched market rival.
      if (cdV && !cdV.aiRecommends && Array.isArray(finalResult['competitors'])) {
        var marketKey = String(cdV.realCompetitor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        finalResult['competitors'] = finalResult['competitors'].filter(function(cc) {
          var key = String(cc && cc.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          var context = String(cc && cc.queryContext || '').toLowerCase();
          if (marketKey && key === marketKey) {
            cc.queryContext = 'head-to-head';
            return true;
          }
          return context.indexOf('ai-ground-truth') === -1
            && context.indexOf('ai-selection-ground-truth') === -1;
        });
      }
    } catch (e) {
      console.warn('[' + jobId + '] Competitor validation failed:', e.message);
    }
    // Expose the selection decision so the result page can label each name by
    // its true source — the AI-displacement banner may only show aiRecommends.
    try {
      var cdX = evidence['competitorDecision'];
      if (cdX) {
        finalResult['competitorDecision'] = {
          selectionVersion: cdX.selectionVersion || null,
          realCompetitor:  cdX.realCompetitor  || null,
          aiRecommends:    cdX.aiRecommends    || null,
          secondAiCompetitor: cdX.secondAiCompetitor || null,
          mentionCount: cdX.mentionCount || 0,
          secondMentionCount: cdX.secondMentionCount || 0,
          distinctQueryCount: cdX.distinctQueryCount || 0,
          secondDistinctQueryCount: cdX.secondDistinctQueryCount || 0,
          aiMentionedCompetitor: cdX.aiMentionedCompetitor || null,
          secondAiMentionedCompetitor: cdX.secondAiMentionedCompetitor || null,
          aiMentionedCount: cdX.aiMentionedCount || 0,
          secondAiMentionedCount: cdX.secondAiMentionedCount || 0,
          aiMentionedQueryCount: cdX.aiMentionedQueryCount || 0,
          secondAiMentionedQueryCount: cdX.secondAiMentionedQueryCount || 0,
          totalResponses: cdX.totalResponses || 0,
          totalQueries: cdX.totalQueries || 0,
          globalBenchmark: cdX.globalBenchmark || null,
          categoryUnowned: cdX.categoryUnowned === true
        };
      }
    } catch (e) {}
    // Merge evidence-level fields not returned by Claude into final result
    if (evidence['socialSignals'] && Object.keys(evidence['socialSignals']).length > 0) {
      finalResult['socialSignals'] = evidence['socialSignals'];
    }
    if (evidence['summaries'] && Object.keys(evidence['summaries']).length > 0) {
      finalResult['summaries'] = evidence['summaries'];
    }
    if (evidence['reviewText'])       finalResult['reviewText']       = evidence['reviewText'];
    if (evidence['apifyText'])        finalResult['apifyText']        = evidence['apifyText'];
    if (evidence['trustpilot'])       finalResult['trustpilot']       = evidence['trustpilot'];
    if (evidence['googleReviews'])    finalResult['googleReviews']    = evidence['googleReviews'];
    if (evidence['competitorApify'])  finalResult['competitorApify']  = evidence['competitorApify'];
    if (evidence['platformSimulations']) finalResult['platformSimulations'] = evidence['platformSimulations'];
    // Platform coverage must describe measurements that actually ran. The
    // OpenAI API is labelled OpenAI rather than consumer ChatGPT because API
    // and chat product answers are not guaranteed to be identical.
    if (evidence['platformSimulations']) {
      var measuredClaude = evidence['platformSimulations']['claude'];
      var measuredOpenAI = evidence['platformSimulations']['openai'];
      finalResult['platformCoverage'] = {
        chatgpt: measuredOpenAI && measuredOpenAI.available
          ? { status: measuredOpenAI.appearedCount > 0 ? 'present' : 'absent', detail: 'Measured with OpenAI ' + (measuredOpenAI.model || 'API') + ' and web search.' }
          : { status: 'unmeasured', detail: 'OpenAI API was not configured for this run.' },
        claude: measuredClaude && measuredClaude.available
          ? { status: measuredClaude.appearedCount > 0 ? 'present' : 'absent', detail: 'Measured with Claude and web search.' }
          : { status: 'unmeasured', detail: 'Claude was not measured in this run.' },
        perplexity: { status: 'unmeasured', detail: 'Not measured.' },
        gemini: { status: 'unmeasured', detail: 'Not measured.' }
      };
    }
    // The dedicated category pass is authoritative for business-model fidelity.
    // Later prose generation must not downgrade a producer into a retailer or
    // shift a B2B platform into an adjacent category.
    if (evidence['inferredCategory']) finalResult['inferredCategory'] = evidence['inferredCategory'];
    console.log('[' + jobId + '] Score:', finalResult.overallScore, '| Verdict:', finalResult.verdictHeadline);

    // ── DUAL-ARENA PILLAR SCORING ─────────────────────────────────────────────
    // Only runs if dual-arena was detected. Online competitor = second AI-named competitor
    // (from real AI answers) when available; falls back to channel search result.
    // Scores each competitor independently in their own arena context.
    // Results stored as finalResult.arenaScores = { brand: {...}, online: {...} }
    try {
      var da = evidence['dualArena'];
      var brandCompName = evidence['competitorDecision'] && evidence['competitorDecision'].realCompetitor;
      // Prefer the second AI-named competitor (from real AI answers) as the online arena competitor.
      // Fall back to the channel search result only when no second competitor exists.
      var secondAiComp = finalResult['competitors'] && finalResult['competitors'][1];
      var onlineComp = secondAiComp
        ? { name: secondAiComp.name, domain: null, source: 'ai-competitor' }
        : evidence['onlineCompetitor'];
      // Guard: if both arenas resolved to the same competitor name, scoring the
      // same entity twice produces meaningless numbers. Collapse to brand-only.
      var normName = function(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
      if (onlineComp && onlineComp.name && brandCompName && normName(onlineComp.name) === normName(brandCompName)) {
        console.log('[' + jobId + '] Dual-arena skipped — both arenas resolved to same competitor (' + brandCompName + '). Running brand-only.');
        onlineComp = null;
      }
      // FIX B — channel-search competitors must never appear in dual-arena online slot
      if (onlineComp && onlineComp.source === 'channel-search') {
        console.log('[' + jobId + '] Dual-arena online arena skipped — onlineCompetitor source is channel-search, not AI-named.');
        onlineComp = null;
      }
      if (da && da.dualArena && onlineComp && onlineComp.name && brandCompName) {
        console.log('[' + jobId + '] Dual-arena scoring: brand=' + brandCompName + ' / online=' + onlineComp.name + ' (source:' + (onlineComp.source || 'channel-search') + ')');
        var arenaResults = await Promise.allSettled([
          scoreArena(evidence, finalResult, brandCompName, 'brand'),
          scoreArena(evidence, finalResult, onlineComp.name, 'online')
        ]);
        var brandArena  = (arenaResults[0].status === 'fulfilled') ? arenaResults[0].value : null;
        var onlineArena = (arenaResults[1].status === 'fulfilled') ? arenaResults[1].value : null;
        if (brandArena || onlineArena) {
          finalResult['arenaScores'] = {
            brand:  brandArena  || null,
            online: onlineArena || null
          };
          finalResult['dualArena'] = {
            detected:               true,
            brandCompetitor:        brandCompName,
            onlineCompetitor:       onlineComp.name,
            onlineCompetitorSource: onlineComp.source || 'channel-search',
            onlineDomain:           onlineComp.domain || null,
            detectionSignals:       da._debug || {}
          };
          console.log('[' + jobId + '] Arena scores saved — brand keyGap:', (brandArena && brandArena.keyGap) || 'n/a',
            '| online keyGap:', (onlineArena && onlineArena.keyGap) || 'n/a');
        }
      } else if (da && da.dualArena) {
        // Dual-arena detected but missing a competitor for one or both arenas — store metadata only
        finalResult['dualArena'] = {
          detected:         true,
          brandCompetitor:  brandCompName || null,
          onlineCompetitor: (onlineComp && onlineComp.name) || null,
          detectionSignals: da._debug || {},
          scoringSkipped:   'Missing competitor name for one or both arenas'
        };
        console.log('[' + jobId + '] Dual-arena metadata saved (scoring skipped — incomplete competitors)');
      }
    } catch (arenaErr) {
      console.warn('[' + jobId + '] Dual-arena scoring failed (non-critical):', arenaErr.message);
    }

    // ── MERGE SECOND AI-NAMED COMPETITOR INTO competitors[] ──────────────────
    // Source of truth: evidence.competitorDecision.secondAiCompetitor — the
    // second-most-mentioned name across real AI simulation response texts.
    // This is ground-truth: it is what AI genuinely said, same standard as
    // the primary competitor. Channel-search domains never enter this slot.
    // The dual-arena block may also have added a competitor via Claude's JSON
    // output (source: 'ai-competitor') — that is a secondary fallback only.
    try {
      var normComp = function(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
      var cd2 = evidence['competitorDecision'];
      var secondAiName = cd2 && cd2.secondAiCompetitor;
      if (secondAiName && !isPlatformName(secondAiName) && !isGenericEntity(secondAiName)) {
        if (!Array.isArray(finalResult['competitors'])) finalResult['competitors'] = [];
        var alreadyIn2 = finalResult['competitors'].some(function(c) {
          return normComp(c && c.name) === normComp(secondAiName);
        });
        if (!alreadyIn2) {
          finalResult['competitors'].push({
            name:         secondAiName,
            advantage:    '',
            gapLocation:  '',
            closeGap:     '',
            evidence:     'Named by AI in real recommendation queries for this category.',
            queryContext: 'ai-ground-truth'
          });
          console.log('[' + jobId + '] Second AI-named competitor "' + secondAiName + '" added to competitors list.');
        }
      } else {
        // Fallback: use dual-arena online competitor only if it was AI-named by Claude
        // (not a channel-search domain). This handles cases where the frequency
        // shortcut didn't find a second name but Claude's analysis did.
        var dualMeta = finalResult['dualArena'];
        if (dualMeta && dualMeta.onlineCompetitor && !dualMeta.scoringSkipped
            && dualMeta.onlineCompetitorSource === 'ai-competitor') {
          var onlineName = dualMeta.onlineCompetitor;
          if (!Array.isArray(finalResult['competitors'])) finalResult['competitors'] = [];
          var alreadyInOnline = finalResult['competitors'].some(function(c) {
            return normComp(c && c.name) === normComp(onlineName);
          });
          if (!alreadyInOnline && !isPlatformName(onlineName) && !isGenericEntity(onlineName)) {
            finalResult['competitors'].push({
              name:         onlineName,
              advantage:    '',
              gapLocation:  '',
              closeGap:     '',
              evidence:     '',
              queryContext: 'online-arena'
            });
            console.log('[' + jobId + '] AI-named dual-arena competitor "' + onlineName + '" added as fallback second competitor.');
          }
        } else if (dualMeta && dualMeta.onlineCompetitor && dualMeta.onlineCompetitorSource !== 'ai-competitor') {
          console.log('[' + jobId + '] Online competitor "' + dualMeta.onlineCompetitor + '" skipped — source is channel-search, not AI-named.');
        }
      }
    } catch (mergeErr) {
      console.warn('[' + jobId + '] Second competitor merge failed (non-critical):', mergeErr.message);
    }
    // FIX A — Trim to 3 after all merge sources have been applied (moved from inside enforcement block)
    finalResult.competitors = (finalResult.competitors || []).slice(0, 3);

    // ── STAGE 3: DELIVERABLES ─────────────────────────────────────────────────
    try {
      var deliverables = generateDeliverables(evidence, finalResult);
      finalResult['deliverables'] = deliverables;
    } catch (err) {
      console.warn('[' + jobId + '] Deliverables failed:', err.message);
    }
    // ── STAGE 3b: AI SIMULATION ──────────────────────────────────────────────
    // Runs the before/after query simulation server-side and saves it with the
    // result, so the paid report always has real word-for-word queries and the
    // free result page shows the exact same data. Failure here never breaks
    // the diagnostic — the report has a graceful fallback.
    try {
      var pDiff  = (finalResult.pillars && finalResult.pillars.difference) || {};
      var pTrust = (finalResult.pillars && finalResult.pillars.trust)      || {};
      var simData = null;
      var preBefore = evidence['aiSimulationBefore'];
      if (preBefore && preBefore.before) {
        try {
          var afterHalf = await runAfterSimulation({
            language:         (preBefore.before && preBefore.before.language) || undefined,
            name:             name,
            category:         category,
            city:             city,
            inferredCategory: finalResult['inferredCategory'] || evidence['inferredCategory'] || category,
            differentiator:   String(pDiff.evidence  || '').slice(0, 200),
            trustSignal:      String(pTrust.evidence || '').slice(0, 200)
          });
          if (afterHalf && afterHalf.after) {
            simData = {
              name:     preBefore.name,
              category: preBefore.category,
              before:   preBefore.before,
              after:    afterHalf.after
            };
          }
        } catch (err) {
          console.warn('[' + jobId + '] After-simulation failed, falling back to full run:', err.message);
        }
      }
      if (!simData) {
        simData = await runSimulation({
          name:             name,
          category:         category,
          city:             city,
          inferredCategory: finalResult['inferredCategory'] || evidence['inferredCategory'] || category,
          differentiator:   String(pDiff.evidence  || '').slice(0, 200),
          trustSignal:      String(pTrust.evidence || '').slice(0, 200)
        });
      }
      if (simData && simData.before && simData.after) {
        finalResult['aiSimulation'] = simData;
        console.log('[' + jobId + '] AI simulation: before ' + simData.before.appearedCount + '/3, after ' + simData.after.appearedCount + '/3');
      }
    } catch (err) {
      console.warn('[' + jobId + '] AI simulation failed:', err.message);
    }
    // ── VERIFICATION: compare against the previous completed run ───────────
    try {
      var prevRow = await getPreviousResult(fingerprint);
      var progressDelta = computeProgressDelta(prevRow, finalResult, evidence);
      if (progressDelta) {
        finalResult['progressDelta'] = progressDelta;
        console.log('[' + jobId + '] Progress vs previous run: '
          + (progressDelta.scoreDelta >= 0 ? '+' : '') + progressDelta.scoreDelta
          + ' | signals changed: ' + progressDelta.signals.length);
      }
    } catch (err) {
      console.warn('[' + jobId + '] Verification delta failed:', err.message);
    }

    // ONE-LINE RECEIPT: everything worth knowing about this run, in a single
    // grep-able JSON line, instead of reconstructing the story from a dozen
    // scattered log lines. This is what should have existed all day \u2014 every
    // debugging session this session took 10+ minutes of log archaeology that
    // this one line would have answered in a glance.
    try {
      var cdSummary = finalResult['competitorDecision'] || {};
      var simB = evidence['aiSimulationBefore'] && evidence['aiSimulationBefore'].before;
      var searchUsed = null;
      try {
        if (simB && Array.isArray(simB.results)) {
          searchUsed = simB.results.some(function(r) { return r && r.sampleCount && r.sampleCount > 1; });
        }
      } catch (e) {}
      console.log('[' + jobId + '] SUMMARY ' + JSON.stringify({
        business:        name,
        score:           finalResult['overallScore'],
        competitor: {
          headToHead:    cdSummary.realCompetitor  || null,
          aiRecommends:  cdSummary.aiRecommends     || null,
          categoryUnowned: !!cdSummary.categoryUnowned,
          source:        cdSummary.source           || null,
          selectionVersion: cdSummary.selectionVersion || null
        },
        groundTruth: {
          language:      simB && simB.language || 'en',
          multiSampled:  searchUsed, // renamed from dualSampled: the redesign samples 4x per query, not 2x \u2014 old field name/value were stale after the frequency-architecture rewrite
          appearedRate:  simB && simB.results ? (simB.results.filter(function(r){return r.appeared;}).length + '/' + simB.results.length) : null
        },
        cacheBusted:     cacheBustedThisRun,
        progressTracked: !!finalResult['progressDelta']
      }));
    } catch (e) {
      console.warn('[' + jobId + '] Summary log failed (non-fatal):', e.message);
    }

    await saveResult(jobId, finalResult);

    // ── SELF-DIAGNOSTIC WRITE ───────────────────────────────────────────────────
    // When the diagnosed business is CHOIVE itself, write the result to the
    // dedicated self_diagnostic table so the homepage can display it live.
    // Keyed on domain so it works regardless of how the description is phrased.
    if (website && website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') === 'choive.com') {
      try {
        var { createClient: _createClient } = require('@supabase/supabase-js');
        var _ws = require('ws');
        var _sb = _createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: _ws } });
        await _sb.from('self_diagnostic').insert({
          job_id:        jobId,
          overall_score: finalResult.overallScore  || 0,
          pillars:       finalResult.pillars        || {},
          verdict:       finalResult.verdictHeadline || '',
          summary:       finalResult.summaryParagraph || '',
          actions:       finalResult.actions         || [],
          created_at:    new Date().toISOString()
        });
        console.log('[' + jobId + '] Self-diagnostic written to self_diagnostic table.');
      } catch (e) {
        console.warn('[' + jobId + '] self_diagnostic write failed (non-fatal):', e.message);
      }
    }

    console.log('[' + jobId + '] Diagnostic complete.');
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, jobId }) };
  } catch (err) {
    console.error('run-diagnostic-background error:', err.message);
    if (jobId) await saveError(jobId, err.message).catch(() => {});
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
