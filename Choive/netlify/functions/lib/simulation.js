// run-diagnostic-background.js
// CHOIVE™ background diagnostic engine
// Stage 1: collect evidence — Stage 2: score — Stage 3: save
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPER_API_KEY, ANTHROPIC_API_KEY
// Optional second-platform measurement: OPENAI_API_KEY, OPENAI_MODEL
const { updateStatus, saveEvidence, saveResult, saveError, buildFingerprint, getPreviousResult } = require('./lib/supabase');
const { searchSerper, searchCompetitors, searchOnlineChannelCompetitor, inferOfficialSite, normalizeUrl } = require('./lib/serper');
const { fetchWebsiteText, fetchCompetitorText, fetchReviewPages, buildReviewText } = require('./lib/fetchWebsite');
const { scoreWithClaude, inferCategory, selectChannelCompetitor, scoreArena, selectBestFitCompetitors } = require('./lib/claude');
const { runOpenAISimulation } = require('./lib/openai-simulation');
const { runGeminiSimulation, runPerplexitySimulation } = require('./lib/additional-platform-simulations');
const { hasValidShape, buildSafeOutput } = require('./lib/validators');
const { fetchSocialEvidence, buildSocialText } = require('./lib/social');
const { fetchApifyEvidence }   = require('./lib/apify');
const { generateDeliverables } = require('./lib/deliverables');
const simulationLib = require('./lib/simulation');
const runBeforeSimulation = typeof simulationLib.runBeforeSimulation === 'function'
  ? simulationLib.runBeforeSimulation
  : async function(input) {
      if (typeof simulationLib.runSimulation !== 'function') throw new Error('No compatible simulation runner is available');
      return simulationLib.runSimulation(input);
    };
const runDirectCompetitorQuestion = typeof simulationLib.runDirectCompetitorQuestion === 'function'
  ? simulationLib.runDirectCompetitorQuestion
  : null;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function safeStr(v) { return typeof v === 'string' ? v.trim() : ''; }
function buildSubjectRecommendationMatcher(name, website) {
  var keys = {};
  function add(value) {
    var key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key) keys[key] = true;
  }
  add(name);
  var domain = normalizeUrl(website || '');
  add(domain);
  add(String(domain || '').split('.')[0]);
  var tokens = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  var acronym = '';
  if (tokens.length >= 3 && tokens.some(function(token) { return /\d/.test(token); })) {
    acronym = tokens.map(function(token) { return /^\d+$/.test(token) ? token : token.charAt(0); }).join('');
    add(acronym);
  }
  return function(value) {
    var key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || keys[key]) return Boolean(key);
    var full = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (full.length >= 5 && key.indexOf(full) !== -1) return true;
    return acronym.length >= 3 && /\d/.test(acronym)
      && (key.indexOf(acronym) === 0 || key.lastIndexOf(acronym) === key.length - acronym.length);
  };
}
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
    digital:1, web:1, saas:1, cloud:1, startup:1, enterprise:1
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
  // Legitimate compact brands such as 3SS, RT-RK, 24i, NAGRA, and ADB must
  // not be rejected merely because none of their tokens exceeds two letters.
  // Generic phrases are word-like; an uppercase/digit compact mark is an
  // identity shape and remains subject to the other competitor checks.
  if (/^[A-Z0-9][A-Z0-9&.+-]{1,15}$/.test(name) && /[A-Z]{2}|[A-Z].*\d|\d.*[A-Z]/.test(name)) return false;
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }
  var diagnosticSecret = process.env.INTERNAL_DIAGNOSTIC_SECRET
    || process.env.INTERNAL_REPORT_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!diagnosticSecret) {
    console.error('run-diagnostic-background: internal diagnostic secret is not configured');
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Diagnostic service is not configured' }) };
  }
  if ((event.headers || {})['x-internal-token'] !== diagnosticSecret) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
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
    const customerQuestion = safeStr(input.customerQuestion).slice(0, 500);
    var isSubjectRecommendation = buildSubjectRecommendationMatcher(name, website);
    const languagePref     = (['de','es','fr','it','nl','pt','pl','tr','sv','da','ja','ko','zh','en','ar','ru','hi','id'].indexOf(safeStr(input.language).toLowerCase()) !== -1) ? safeStr(input.language).toLowerCase() : '';
    if (!jobId)                      throw new Error('Missing jobId');
    if (!name || !category || !city) throw new Error('Missing required input fields');
    await updateStatus(jobId, 'collecting_evidence', 'collecting_evidence').catch(() => {});
    // Every diagnostic is a fresh measurement. Historical jobs remain stored
    // for audit and progress comparison, but their evidence, provider answers,
    // and competitor decisions are never used as the input to this run.
    const fingerprint = buildFingerprint({ name, category, city, website });
    let evidence = null;
    let cacheBustedThisRun = false;
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
        name, category, city, website, description, knownCompetitors, customerQuestion,
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
      // Stored with this job for its audit trail. New diagnostics explicitly
      // discard cached AI responses above and measure every provider again.
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
            knownCompetitors:  knownCompetitors || '',
            customerQuestion:  customerQuestion || ''
          });
          if (simBefore && simBefore.before) {
            evidence['aiSimulationBefore'] = simBefore;
            console.log('[' + jobId + '] Before-simulation: appeared ' + simBefore.before.appearedCount + '/3');
            var directCompetitorCheck = null;
            try {
              directCompetitorCheck = runDirectCompetitorQuestion ? await runDirectCompetitorQuestion({
                language: simBefore.before.language,
                name: name,
                website: website,
                category: category,
                city: city,
                description: description,
                inferredCategory: evidence['inferredCategory'] || category
              }, true) : null;
              evidence['directCompetitorCheck'] = directCompetitorCheck;
            } catch (directErr) {
              console.warn('[' + jobId + '] Direct competitor question failed:', directErr.message);
            }
            var sharedPlatformQueries = (simBefore.before.results || []).concat(
              directCompetitorCheck && Array.isArray(directCompetitorCheck.results)
                ? directCompetitorCheck.results
                : []
            );
            // Measure every external provider against the exact same localized
            // buyer questions. Each provider remains independently attributed.
            try {
              var externalPlatformInput = {
                name: name,
                category: evidence['inferredCategory'] || category,
                city: city,
                language: simBefore.before.language,
                sourceResults: sharedPlatformQueries
              };
              var externalRuns = await Promise.allSettled([
                runOpenAISimulation(externalPlatformInput),
                runGeminiSimulation(externalPlatformInput),
                runPerplexitySimulation(externalPlatformInput)
              ]);
              var openaiSimulation = externalRuns[0].status === 'fulfilled' ? externalRuns[0].value : { available: false, provider: 'openai', status: 'failed', reason: String(externalRuns[0].reason && externalRuns[0].reason.message || 'Request failed') };
              var geminiSimulation = externalRuns[1].status === 'fulfilled' ? externalRuns[1].value : { available: false, provider: 'gemini', status: 'failed', reason: String(externalRuns[1].reason && externalRuns[1].reason.message || 'Request failed') };
              var perplexitySimulation = externalRuns[2].status === 'fulfilled' ? externalRuns[2].value : { available: false, provider: 'perplexity', status: 'failed', reason: String(externalRuns[2].reason && externalRuns[2].reason.message || 'Request failed') };
              evidence['platformSimulations'] = evidence['platformSimulations'] || {};
              var claudeCompletedSamples = sharedPlatformQueries.reduce(function(total, result) {
                return total + Number(result && result.sampleCount || 0);
              }, 0);
              var claudeExpectedSamples = sharedPlatformQueries.reduce(function(total, result) {
                return total + Number(result && result.expectedSamples || 1);
              }, 0);
              var claudeReplacementResult = sharedPlatformQueries.find(function(result) {
                return result && /branded replacement/i.test(String(result.label || ''));
              });
              evidence['platformSimulations']['claude'] = {
                available: claudeCompletedSamples > 0,
                configured: Boolean(process.env.ANTHROPIC_API_KEY),
                provider: 'anthropic',
                status: claudeCompletedSamples === claudeExpectedSamples
                  ? 'complete'
                  : (claudeCompletedSamples > 0 ? 'partial' : 'failed'),
                complete: claudeCompletedSamples === claudeExpectedSamples,
                language: simBefore.before.language,
                appearedCount: simBefore.before.appearedCount,
                totalQueries: simBefore.before.totalQueries,
                completedSamples: claudeCompletedSamples,
                expectedSamples: claudeExpectedSamples,
                recommendationCompleted: Boolean(claudeReplacementResult && Number(claudeReplacementResult.sampleCount || 0) > 0),
                recommendationQuery: claudeReplacementResult && claudeReplacementResult.query || null,
                recommendationResponse: claudeReplacementResult && claudeReplacementResult.response || null,
                results: sharedPlatformQueries
              };
              evidence['platformSimulations']['openai'] = openaiSimulation;
              evidence['platformSimulations']['gemini'] = geminiSimulation;
              evidence['platformSimulations']['perplexity'] = perplexitySimulation;
              console.log('[' + jobId + '] External simulations: OpenAI=' + (openaiSimulation.status || 'unknown') + ', Gemini=' + (geminiSimulation.status || 'unknown') + ', Perplexity=' + (perplexitySimulation.status || 'unknown'));
            } catch (openaiErr) {
              console.warn('[' + jobId + '] External platform simulations failed:', openaiErr.message);
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
              var allSimLabeledResponses = []; // preserves which buyer question produced each answer
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
                    allSimLabeledResponses.push({ label: r.label || 'Buyer query', text: txt });
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
                var subjectCandidateKeys = {};
                subjectCandidateKeys[normSelf] = true;
                var subjectDomain = normalizeUrl(website || evidence['inferredOfficialSite'] || '');
                var subjectDomainCore = String(subjectDomain || '').split('.')[0].replace(/[^a-z0-9]/g, '');
                var subjectDomainFull = String(subjectDomain || '').replace(/[^a-z0-9]/g, '');
                if (subjectDomainCore) subjectCandidateKeys[subjectDomainCore] = true;
                if (subjectDomainFull) subjectCandidateKeys[subjectDomainFull] = true;
                var subjectWords = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
                if (subjectWords.length >= 3 && subjectWords.some(function(token) { return /\d/.test(token); })) {
                  subjectCandidateKeys[subjectWords.map(function(token) {
                    return /^\d+$/.test(token) ? token : token.charAt(0);
                  }).join('')] = true;
                }
                var isExtractedSubject = function(value) {
                  var key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                  if (!key) return false;
                  if (subjectCandidateKeys[key]) return true;
                  // Handle combined forms such as "3SS (3 Screen Solutions)".
                  return Object.keys(subjectCandidateKeys).some(function(subjectKey) {
                    return subjectKey.length >= 3
                      && (key === subjectKey || key.indexOf(subjectKey) === 0 || key.lastIndexOf(subjectKey) === key.length - subjectKey.length);
                  });
                };
                var seenKeys = {};
                var uniqueCandidates = allCandidates.filter(function(n) {
                  if (!n) return false;
                  var key = n.toLowerCase().replace(/[^a-z0-9]/g, '');
                  var keyWithoutTld = String(n).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].replace(/\.[a-z]{2,}$/i, '').replace(/[^a-z0-9]/g, '');
                  if (subjectCandidateKeys[key] || subjectCandidateKeys[keyWithoutTld]) return false;
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
                var brandedRecommendationResult = sharedPlatformQueries.find(function(result) {
                  return result && /branded replacement/i.test(String(result.label || ''));
                });
                var brandedResponses = brandedRecommendationResult
                  ? ((Array.isArray(brandedRecommendationResult.allResponses) && brandedRecommendationResult.allResponses.length)
                    ? brandedRecommendationResult.allResponses
                    : [brandedRecommendationResult.response])
                  : [];
                var directMarkerRecommendation = null;
                brandedResponses.some(function(response) {
                  var marker = String(response || '').match(/(?:^|\n)\s*TOP_RECOMMENDATION\s*:\s*([^\n\r]+)/i);
                  if (!marker) return false;
                  var value = String(marker[1] || '').replace(/[*_`]/g, '').trim();
                  if (!value || /^none\b/i.test(value) || isExtractedSubject(value)) return false;
                  directMarkerRecommendation = value;
                  return true;
                });
                // The explicit branded buyer question already returns one
                // machine-readable recommendation. Use that literal answer
                // instead of paying Sonnet to reinterpret the same transcript.
                var extractedCompetitors = directMarkerRecommendation ? {
                  first: directMarkerRecommendation,
                  second: null,
                  firstCount: 1,
                  secondCount: 0,
                  directMarker: true
                } : null;
                // Legacy transcript-wide extraction is opt-in only. It is
                // expensive and can confuse the subject with a competitor.
                if (!extractedCompetitors
                    && process.env.ENABLE_LEGACY_RECOMMENDATION_EXTRACTION === 'true'
                    && allSimResponsesOrig.length > 0) {
                  try {
                    var hintList = uniqueCandidates.slice(0, 12).map(function(c) {
                      // Strip TLD for cleaner display (doncarne.de → doncarne.de shown as-is; scoring strips it)
                      return c;
                    }).join(', ');
                    // Read every recorded sample. Limiting this to six silently
                    // dropped some buyer questions when each query had four runs.
                    var responseSnippets = allSimLabeledResponses.map(function(item, i) {
                      return 'Response ' + (i + 1) + ' [' + item.label + ']:\n' + String(item.text).slice(0, 1200);
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
                      + '5. EVIDENCE PRIORITY: Treat known competitor names and domains only as identity hints, never as automatic winners. Prioritise candidates from the explicit "Named competitor shortlist" answer after verifying that they pass the product, buyer, commercial-model, geography, and market-breadth tests.\n'
                      + '6. Rank by closest overall purchasing-substitute fit first, then by repeated support across independent samples. For a multi-market subject, a candidate covering the same markets outranks a specialist covering only one. The most directly competing business goes in "first".\n'
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
                        max_tokens: 400,
                        temperature: 0,
                        messages: [{ role: 'user', content: extractPrompt }],
                        output_config: {
                          format: {
                            type: 'json_schema',
                            schema: {
                              type: 'object',
                              properties: {
                                first: { type: 'string' },
                                second: { type: 'string' },
                                firstCount: { type: 'integer' },
                                secondCount: { type: 'integer' }
                              },
                              required: ['first', 'second', 'firstCount', 'secondCount'],
                              additionalProperties: false
                            }
                          }
                        }
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
                      var extractStart = extractClean.indexOf('{');
                      var extractEnd = extractClean.lastIndexOf('}');
                      if (extractStart >= 0 && extractEnd > extractStart) {
                        extractClean = extractClean.slice(extractStart, extractEnd + 1);
                      }
                      var extractParsed = JSON.parse(extractClean);
                      if (extractParsed && typeof extractParsed === 'object') {
                        var f = String(extractParsed.first  || '').trim();
                        var s = String(extractParsed.second || '').trim();
                        if (isExtractedSubject(f)) {
                          console.warn('[' + jobId + '] Direct extraction returned the subject as first competitor — excluded: ' + f);
                          f = '';
                        }
                        if (isExtractedSubject(s)) {
                          console.warn('[' + jobId + '] Direct extraction returned the subject as second competitor — excluded: ' + s);
                          s = '';
                        }
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
                    console.warn('[' + jobId + '] Structured recommendation extraction failed; leaving recommendation empty:', extractErr.message);
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
                  var verifiedFirst = extractedCompetitors.directMarker
                    ? extractedCompetitors.first
                    : (verifiedFirstQueryCount >= 2 ? extractedCompetitors.first : null);
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
                  // Search-result domains are identity hints, not verified
                  // recommendations. If structured extraction returns no name,
                  // preserve an honest empty result instead of frequency-
                  // matching a source domain such as market.us.
                  console.log('[' + jobId + '] Direct extraction returned no verified names — no recommendation inferred');
                  evidence['competitorDecision'] = {
                    realCompetitor:     null,
                    aiRecommends:       null,
                    secondAiCompetitor: null,
                    source:             'ai-ground-truth',
                    selectionVersion:   3,
                    mentionCount:       0,
                    totalResponses:     allSimResponses.length,
                    distinctQueryCount: 0,
                    secondMentionCount: 0,
                    secondDistinctQueryCount: 0,
                    aiMentionedCompetitor: null,
                    secondAiMentionedCompetitor: null,
                    aiMentionedCount: 0,
                    secondAiMentionedCount: 0,
                    aiMentionedQueryCount: 0,
                    secondAiMentionedQueryCount: 0,
                    totalQueries:       simResponseGroups.length,
                    categoryUnowned:    true
                  };
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
      if (process.env.OPENAI_API_KEY && cachedBeforeForOpenAI && (!cachedOpenAI || !cachedOpenAI.available || cachedOpenAI.complete === false || !Number(cachedOpenAI.expectedSamples))) {
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

    // Backfill Gemini and Perplexity independently for cached evidence. Their
    // absence must never be hidden by another provider's successful result.
    try {
      var cachedBeforeForNewPlatforms = evidence['aiSimulationBefore'] && evidence['aiSimulationBefore'].before;
      if (cachedBeforeForNewPlatforms) {
        var cachedSharedQueries = (cachedBeforeForNewPlatforms.results || []).concat(
          evidence['directCompetitorCheck'] && Array.isArray(evidence['directCompetitorCheck'].results)
            ? evidence['directCompetitorCheck'].results : []
        );
        var cachedPlatformInput = {
          name: name,
          category: evidence['inferredCategory'] || category,
          city: city,
          language: cachedBeforeForNewPlatforms.language,
          sourceResults: cachedSharedQueries
        };
        evidence['platformSimulations'] = evidence['platformSimulations'] || {};
        var cachedGemini = evidence['platformSimulations']['gemini'];
        var cachedPerplexity = evidence['platformSimulations']['perplexity'];
        var backfillJobs = [];
        var backfillKeys = [];
        if (!cachedGemini || !cachedGemini.available || cachedGemini.complete === false) {
          backfillKeys.push('gemini');
          backfillJobs.push(runGeminiSimulation(cachedPlatformInput));
        }
        if (!cachedPerplexity || !cachedPerplexity.available || cachedPerplexity.complete === false) {
          backfillKeys.push('perplexity');
          backfillJobs.push(runPerplexitySimulation(cachedPlatformInput));
        }
        if (backfillJobs.length) {
          var backfillResults = await Promise.allSettled(backfillJobs);
          backfillResults.forEach(function(result, index) {
            var key = backfillKeys[index];
            evidence['platformSimulations'][key] = result.status === 'fulfilled'
              ? result.value
              : { available: false, configured: true, provider: key, status: 'failed', reason: String(result.reason && result.reason.message || 'Request failed'), results: [] };
          });
          await saveEvidence(jobId, evidence).catch(function(err) {
            console.warn('[' + jobId + '] New-platform cache backfill save failed:', err.message);
          });
        }
      }
    } catch (newPlatformBackfillErr) {
      console.warn('[' + jobId + '] Gemini/Perplexity cache backfill failed:', newPlatformBackfillErr.message);
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
    // Platform coverage must describe measurements that actually ran. The UI
    // uses "ChatGPT"; the detail remains explicit that this is an API measure.
    if (evidence['platformSimulations']) {
      var measuredClaude = evidence['platformSimulations']['claude'];
      var measuredOpenAI = evidence['platformSimulations']['openai'];
      var measuredGemini = evidence['platformSimulations']['gemini'];
      var measuredPerplexity = evidence['platformSimulations']['perplexity'];
      var coverageForRun = function(run, label) {
        if (!run || run.configured === false || run.status === 'not_configured') return { status: 'unmeasured', detail: label + ' API is not configured.' };
        if (!run.available) return { status: 'failed', detail: label + ' measurement failed.' };
        var state = run.complete === false ? 'partial' : (Number(run.appearedCount || 0) > 0 ? 'present' : 'absent');
        return { status: state, detail: 'Measured with ' + label + (run.model ? ' ' + run.model : '') + '. ' + Number(run.completedSamples || run.totalQueries || 0) + ' of ' + Number(run.expectedSamples || run.totalQueries || 0) + ' samples completed.' };
      };
      finalResult['platformCoverage'] = {
        chatgpt: measuredOpenAI && measuredOpenAI.available
          ? { status: measuredOpenAI.complete === false ? 'partial' : (measuredOpenAI.appearedCount > 0 ? 'present' : 'absent'), detail: 'Measured with OpenAI ' + (measuredOpenAI.model || 'API') + ' and web search. ' + Number(measuredOpenAI.completedSamples || 0) + ' of ' + Number(measuredOpenAI.expectedSamples || 0) + ' samples completed.' }
          : { status: 'unmeasured', detail: 'OpenAI API was not configured for this run.' },
        claude: measuredClaude && measuredClaude.available
          ? { status: measuredClaude.appearedCount > 0 ? 'present' : 'absent', detail: 'Measured with Claude and web search.' }
          : { status: 'unmeasured', detail: 'Claude was not measured in this run.' },
        perplexity: coverageForRun(measuredPerplexity, 'Perplexity'),
        gemini: coverageForRun(measuredGemini, 'Gemini')
      };
      var openaiRecommendations = measuredOpenAI && measuredOpenAI.recommendations
        ? [measuredOpenAI.recommendations.primary, measuredOpenAI.recommendations.second, measuredOpenAI.recommendations.third].filter(Boolean)
        : [];
      var findDirectRecommendationResult = function(run) {
        if (!run || !Array.isArray(run.results)) return null;
        return run.results.find(function(result) {
          return result && /branded replacement/i.test(String(result.label || ''));
        });
      };
      var extractDirectRecommendation = function(run) {
        var direct = findDirectRecommendationResult(run);
        if (!direct) return null;
        var responses = Array.isArray(direct.allResponses) && direct.allResponses.length
          ? direct.allResponses : [direct.response];
        for (var i = 0; i < responses.length; i++) {
          var matches = String(responses[i] || '').match(/(?:^|\n)\s*TOP_RECOMMENDATION\s*:\s*([^\n\r]+)/i);
          if (!matches) continue;
          var value = String(matches[1] || '').replace(/[*_`]/g, '').trim();
          if (value && !/^none\b/i.test(value)) return value;
        }
        return null;
      };
      var subjectRecommendationKeys = {};
      var addSubjectKey = function(value) {
        var key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (key) subjectRecommendationKeys[key] = true;
      };
      addSubjectKey(name);
      var subjectDomain = normalizeUrl((evidence && (evidence.website || evidence.inferredOfficialSite)) || '');
      addSubjectKey(subjectDomain);
      addSubjectKey(String(subjectDomain || '').split('.')[0]);
      var subjectTokens = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
      var subjectAcronymKey = '';
      if (subjectTokens.length >= 3 && subjectTokens.some(function(token) { return /\d/.test(token); })) {
        subjectAcronymKey = subjectTokens.map(function(token) {
          return /^\d+$/.test(token) ? token : token.charAt(0);
        }).join('');
        addSubjectKey(subjectAcronymKey);
      }
      isSubjectRecommendation = function(value) {
        var key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!key || subjectRecommendationKeys[key]) return Boolean(key);
        // Providers often return a compact brand plus its expanded legal or
        // descriptive name, e.g. "3SS (3 Screen Solutions)". Treat any value
        // containing the full normalized subject identity as the subject.
        var fullSubjectKey = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (fullSubjectKey.length >= 5 && key.indexOf(fullSubjectKey) !== -1) return true;
        // Digit-bearing coined acronyms such as 3SS are sufficiently specific
        // to match combined forms even when the expansion varies slightly
        // ("3 Screen Solutions" versus "3 screens solutions").
        return subjectAcronymKey.length >= 3
          && /\d/.test(subjectAcronymKey)
          && (key.indexOf(subjectAcronymKey) === 0 || key.lastIndexOf(subjectAcronymKey) === key.length - subjectAcronymKey.length);
      };
      var dedupeRecommendations = function(values) {
        var seen = {};
        return values.filter(function(value) {
          var key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!key || seen[key] || isSubjectRecommendation(value)) return false;
          seen[key] = true;
          return true;
        });
      };
      var firstValidRecommendation = function(values) {
        return dedupeRecommendations(values || [])[0] || null;
      };
      var firstLaneRecommendation = function(values) {
        var seen = {};
        return (values || []).filter(function(value) {
          var key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          // A provider may honestly recommend the diagnosed business itself.
          // Preserve that answer in the attributed provider lane. Subject
          // filtering still happens later when constructing the competitor
          // candidate list and comparison arena, where the subject cannot be
          // its own competitor.
          if (!key || seen[key] || isPlatformName(value) || isGenericEntity(value) || isGenericPhrase(value)) return false;
          seen[key] = true;
          return true;
        })[0] || null;
      };
      var laneStatus = function(run, recommendation) {
        if (!run || run.configured === false || run.status === 'not_configured') return 'not_configured';
        if (!run.available || run.status === 'failed') return 'failed';
        if (run.recommendationCompleted === false) return 'failed';
        return recommendation ? 'recommended' : 'no_recommendation';
      };
      var claudeTop = firstLaneRecommendation([extractDirectRecommendation(measuredClaude)]);
      var openaiTop = firstLaneRecommendation([measuredOpenAI && measuredOpenAI.topRecommendation]);
      var geminiTop = firstLaneRecommendation([measuredGemini && measuredGemini.topRecommendation]);
      var perplexityTop = firstLaneRecommendation([measuredPerplexity && measuredPerplexity.topRecommendation]);
      var claudeDirectResult = findDirectRecommendationResult(measuredClaude);
      var platformLanes = [
        { key: 'claude', label: 'Claude', run: measuredClaude, recommendation: claudeTop, query: claudeDirectResult && claudeDirectResult.query || null },
        { key: 'openai', label: 'ChatGPT', run: measuredOpenAI, recommendation: openaiTop, query: measuredOpenAI && measuredOpenAI.recommendationQuery || null },
        { key: 'perplexity', label: 'Perplexity', run: measuredPerplexity, recommendation: perplexityTop, query: measuredPerplexity && measuredPerplexity.recommendationQuery || null },
        { key: 'gemini', label: 'Gemini', run: measuredGemini, recommendation: geminiTop, query: measuredGemini && measuredGemini.recommendationQuery || null }
      ].map(function(lane) {
        return {
          key: lane.key,
          platform: lane.label,
          recommendation: lane.recommendation,
          status: laneStatus(lane.run, lane.recommendation),
          query: lane.query,
          subjectAppeared: Boolean(lane.run && Number(lane.run.appearedCount || 0) > 0),
          completedSamples: Number(lane.run && lane.run.completedSamples || 0),
          expectedSamples: Number(lane.run && lane.run.expectedSamples || 0),
          model: lane.run && lane.run.model || null
        };
      });
      finalResult['platformRecommendationLanes'] = platformLanes;
      finalResult['multiPlatformRecommendations'] = {
        claude: claudeTop ? [claudeTop] : [],
        openai: openaiTop ? [openaiTop] : [],
        perplexity: perplexityTop ? [perplexityTop] : [],
        gemini: geminiTop ? [geminiTop] : [],
        openaiComplete: measuredOpenAI ? measuredOpenAI.complete !== false : false,
        note: 'Each platform reports one independently measured top recommendation. Identical names remain separately attributed.'
      };
      var completedPlatformRuns = [measuredClaude, measuredOpenAI, measuredPerplexity, measuredGemini].filter(function(run) {
        return run && run.available;
      });
      var platformsWithVisibility = completedPlatformRuns.filter(function(run) {
        return Number(run.appearedCount || 0) > 0;
      });
      if (platformsWithVisibility.length > 0) {
        var visibleInEveryQueryOnEveryPlatform = completedPlatformRuns.length > 0 && completedPlatformRuns.every(function(run) {
          return Number(run.totalQueries || 0) > 0
            && Number(run.appearedCount || 0) === Number(run.totalQueries || 0);
        });
        finalResult['verdictHeadline'] = visibleInEveryQueryOnEveryPlatform
          ? 'Visible across measured AI platforms'
          : 'Considered. Not consistently recommended.';
      }
    }
    // The dedicated category pass is authoritative for business-model fidelity.
    // Later prose generation must not downgrade a producer into a retailer or
    // shift a B2B platform into an adjacent category.
    if (evidence['inferredCategory']) finalResult['inferredCategory'] = evidence['inferredCategory'];
    console.log('[' + jobId + '] Score:', finalResult.overallScore, '| Verdict:', finalResult.verdictHeadline);

    // ── FOUR-PLATFORM RECOMMENDATION ARENA ──────────────────────────────────
    // Keep one lane per measured platform, even when two platforms return the
    // same company. Duplicate companies are scored once and reused so the UI
    // preserves attribution without paying for duplicate comparison calls.
    try {
      var multiRecs = finalResult['multiPlatformRecommendations'] || {};
      var claudeRecs = Array.isArray(multiRecs.claude) ? multiRecs.claude : [];
      var openaiRecs = Array.isArray(multiRecs.openai) ? multiRecs.openai : [];
      var perplexityRecs = Array.isArray(multiRecs.perplexity) ? multiRecs.perplexity : [];
      var geminiRecs = Array.isArray(multiRecs.gemini) ? multiRecs.gemini : [];
      var openaiResearchRecs = measuredOpenAI && measuredOpenAI.competitorShortlist
        ? [measuredOpenAI.competitorShortlist.primary, measuredOpenAI.competitorShortlist.second, measuredOpenAI.competitorShortlist.third].filter(Boolean)
        : [];
      var perplexityResearchRecs = measuredPerplexity && measuredPerplexity.competitorRecommendation
        ? [measuredPerplexity.competitorRecommendation] : [];
      var geminiResearchRecs = measuredGemini && measuredGemini.competitorRecommendation
        ? [measuredGemini.competitorRecommendation] : [];
      var researchedRecs = (finalResult['competitors'] || []).map(function(comp) { return comp && comp.name; }).filter(Boolean);
      var orderedComparisonCandidates = [];
      claudeRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'Claude' }); });
      openaiRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'ChatGPT measurement (OpenAI API)' }); });
      perplexityRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'Perplexity' }); });
      geminiRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'Gemini' }); });
      openaiResearchRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'ChatGPT competitor research (OpenAI API)' }); });
      perplexityResearchRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'Perplexity competitor research' }); });
      geminiResearchRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'Gemini competitor research' }); });
      researchedRecs.forEach(function(value) { orderedComparisonCandidates.push({ name: value, source: 'Market analysis' }); });
      var subjectComparisonKey = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      var candidateMap = {};
      orderedComparisonCandidates.forEach(function(candidate) {
        var key = String(candidate.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!key || key === subjectComparisonKey || isSubjectRecommendation(candidate.name) || isPlatformName(candidate.name)) return;
        if (!candidateMap[key]) candidateMap[key] = { name: candidate.name, sources: [] };
        if (candidateMap[key].sources.indexOf(candidate.source) === -1) candidateMap[key].sources.push(candidate.source);
      });
      var combinedCandidates = Object.keys(candidateMap).map(function(key) { return candidateMap[key]; });
      var adjudicated = await selectBestFitCompetitors(evidence, combinedCandidates);
      if (adjudicated && adjudicated.best) {
        finalResult['bestFitMarketCompetitor'] = adjudicated.best;
        finalResult['marketCompetitorDecision'] = {
          name: adjudicated.best.name,
          reason: adjudicated.best.reason,
          supportingSources: adjudicated.best.sources || [],
          runnerUp: adjudicated.runnerUp || null,
          selectionRule: 'Strongest wider-market alternative across completed provider research; this does not replace the separately researched head-to-head competitor.'
        };
        if (Array.isArray(finalResult['competitors'])) {
          var adjudicatedKey = String(adjudicated.best.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          var headToHeadKey = String(finalResult['competitorDecision'] && finalResult['competitorDecision'].realCompetitor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          var adjudicatedIndex = finalResult['competitors'].findIndex(function(comp) {
            return String(comp && comp.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === adjudicatedKey;
          });
          var adjudicatedCard = adjudicatedIndex >= 0
            ? finalResult['competitors'].splice(adjudicatedIndex, 1)[0]
            : { name: adjudicated.best.name };
          adjudicatedCard.queryContext = adjudicatedKey === headToHeadKey ? 'head-to-head' : 'market-competitor';
          adjudicatedCard.evidence = adjudicated.best.reason;
          adjudicatedCard.selectionSources = adjudicated.best.sources || [];
          if (adjudicatedKey === headToHeadKey) finalResult['competitors'].unshift(adjudicatedCard);
          else finalResult['competitors'].push(adjudicatedCard);
        }
      }

      var recommendationLanes = Array.isArray(finalResult['platformRecommendationLanes'])
        ? finalResult['platformRecommendationLanes'] : [];
      var uniqueArenaNames = [];
      var arenaNameByKey = {};
      recommendationLanes.forEach(function(lane) {
        var laneName = String(lane && lane.recommendation || '').trim();
        var laneKey = laneName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!laneKey || laneKey === subjectComparisonKey || isSubjectRecommendation(laneName) || isPlatformName(laneName)) return;
        if (!arenaNameByKey[laneKey]) {
          arenaNameByKey[laneKey] = laneName;
          uniqueArenaNames.push(laneName);
        }
      });
      var arenaScores = await Promise.allSettled(uniqueArenaNames.map(function(arenaName) {
        return scoreArena(evidence, finalResult, arenaName, 'competitor');
      }));
      var arenaScoreByKey = {};
      uniqueArenaNames.forEach(function(arenaName, index) {
        var scoreResult = arenaScores[index];
        if (scoreResult && scoreResult.status === 'fulfilled' && scoreResult.value) {
          arenaScoreByKey[arenaName.toLowerCase().replace(/[^a-z0-9]/g, '')] = scoreResult.value;
        }
      });
      finalResult['competitorComparison'] = {
        entries: recommendationLanes.map(function(lane) {
          var laneName = String(lane && lane.recommendation || '').trim();
          var laneKey = laneName.toLowerCase().replace(/[^a-z0-9]/g, '');
          return {
            platform: lane.platform,
            platformKey: lane.key,
            name: laneName || null,
            status: lane.status,
            query: lane.query || null,
            subjectAppeared: Boolean(lane.subjectAppeared),
            score: laneKey ? (arenaScoreByKey[laneKey] || null) : null
          };
        }),
        selectionRule: 'One independently measured top recommendation per platform. Identical company names remain in separate attributed lanes.'
      };
    } catch (comparisonErr) {
      console.warn('[' + jobId + '] Universal competitor comparison failed (non-critical):', comparisonErr.message);
    }

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
      if (secondAiName && !isSubjectRecommendation(secondAiName) && !isPlatformName(secondAiName) && !isGenericEntity(secondAiName)) {
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
    // ── STAGE 3b: MEASURED AI ANSWERS ────────────────────────────────────────
    // Persist the real answers already collected earlier. Do not spend three
    // additional Claude calls creating hypothetical "after optimisation"
    // transcripts. Progress is verified by a later diagnostic rerun.
    try {
      var preBefore = evidence['aiSimulationBefore'];
      if (preBefore && preBefore.before) {
        finalResult['aiSimulation'] = {
          name: preBefore.name,
          category: preBefore.category,
          before: preBefore.before,
          after: null,
          projectionPolicy: 'No hypothetical AI answers generated. Implement changes and rerun to verify progress.'
        };
        console.log('[' + jobId + '] AI measurement saved: current visibility '
          + preBefore.before.appearedCount + '/' + preBefore.before.totalQueries
          + ' (projected after-state disabled)');
      }
    } catch (err) {
      console.warn('[' + jobId + '] AI measurement persistence failed:', err.message);
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
