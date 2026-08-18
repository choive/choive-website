// verify-fix.js
// CHOIVE™ — "I made my fixes, check them" endpoint.
// The owner clicks a button after publishing their fixes. This function looks
// at their live website RIGHT NOW, compares it to how it looked in their last
// CHOIVE run, and tells them — in plain words — which fixes are now live.
// If at least one fix is newly live and the owner asked to re-run, it kicks off
// a real re-run (reusing the exact same flow as rerun-diagnostic.js) so the new
// score is measured, never guessed.
//
// It never invents progress: every "now live" is read straight from the live
// site, and every "was" value comes from the stored evidence of the last run.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL

const crypto   = require('crypto');
const supabase = require('./lib/supabase');
const { fetchWebsiteText } = require('./lib/fetchWebsite');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(statusCode, obj) {
  return { statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function sameHash(a, b) {
  var left = Buffer.from(String(a || ''), 'utf8');
  var right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The fixes we can check mechanically from the live site. Labels are written so
// a non-technical owner understands them at a glance.
const FIX_CHECKS = [
  { key: 'hasLlmsTxt',         label: 'Your AI facts file (llms.txt) is live on your website' },
  { key: 'hasSchema',          label: 'Your website has AI-readable business info (schema)' },
  { key: 'hasMetaDescription', label: 'Your search description is set' },
  { key: 'hasTitle',           label: 'Your page title is set' },
  { key: 'hasH1',              label: 'Your homepage has a clear main headline' },
  { key: 'hasSitemap',         label: 'Your sitemap is live' },
  { key: 'hasRobots',          label: 'Your robots file is live' },
  { key: 'botCrawlable',       label: 'AI tools can read your website' }
];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { error: 'Invalid JSON' }); }

  var parentJobId = String(body.parentJobId || '').trim();
  var verificationToken = String(body.verificationToken || '').trim().slice(0, 128);
  var wantRerun = body.triggerRerun === true;

  if (!/^[0-9a-f-]{36}$/i.test(parentJobId) || !verificationToken) {
    return json(400, { error: 'Missing verification details' });
  }

  // Fetch the original diagnostic (for the website URL + fingerprint + auth).
  var original;
  try { original = await supabase.getDiagnostic(parentJobId); }
  catch (err) { return json(500, { error: 'Could not fetch original diagnostic' }); }
  if (!original) return json(404, { error: 'Original diagnostic not found' });
  if (!original.paid) return json(403, { error: 'Only paid diagnostics can be checked this way' });

  // Same browser-ownership check as rerun-diagnostic.js.
  var input = original.input || {};
  var expectedTokenHash = input._consumerVerificationTokenHash;
  var suppliedTokenHash = crypto.createHash('sha256').update(verificationToken).digest('hex');
  if (!expectedTokenHash || !sameHash(expectedTokenHash, suppliedTokenHash)) {
    return json(403, { error: 'This browser cannot check that diagnostic' });
  }

  var website = input.website || '';
  if (!website) return json(200, { available: false, reason: 'no_website' });

  // Baseline signals from the last completed run (stored evidence).
  var baseline = {};
  try {
    var fingerprint = original.business_fingerprint || supabase.buildFingerprint(input);
    var prev = await supabase.getPreviousResult(fingerprint);
    baseline = (prev && prev.evidence && (prev.evidence.websiteSignals || prev.evidence.website)) || {};
  } catch (err) {
    console.warn('verify-fix: baseline lookup failed:', err.message);
  }

  // Read the live site right now.
  var current = {};
  try {
    var web = await fetchWebsiteText(website);
    current = (web && web.signals) || {};
  } catch (err) {
    console.warn('verify-fix: live fetch failed:', err.message);
    return json(200, { available: false, reason: 'fetch_failed' });
  }

  // Build the plain-language comparison.
  var checks = FIX_CHECKS.map(function (c) {
    var was = baseline[c.key] === true;
    var now = current[c.key] === true;
    return { key: c.key, label: c.label, was: was, now: now, newlyFixed: (!was && now) };
  });
  var newlyFixed = checks.filter(function (c) { return c.newlyFixed; });
  var liveCount = checks.filter(function (c) { return c.now; }).length;

  var result = {
    available: true,
    website: website,
    checks: checks,
    newlyFixedCount: newlyFixed.length,
    liveCount: liveCount,
    totalChecks: checks.length,
    rerunStarted: false,
    newJobId: null
  };

  // If the owner asked to re-run AND something is genuinely newly live, start a
  // real re-run using the same trusted flow as rerun-diagnostic.js.
  if (wantRerun && newlyFixed.length > 0) {
    var newJobId = crypto.randomUUID();
    try {
      await supabase.createDiagnosticWithParent(newJobId, input, parentJobId);
      var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
      var triggerResponse = await fetch(siteUrl + '/.netlify/functions/run-diagnostic-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': process.env.INTERNAL_DIAGNOSTIC_SECRET || process.env.INTERNAL_REPORT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
        },
        body: JSON.stringify({ jobId: newJobId, input: input })
      });
      if (!triggerResponse.ok) throw new Error('Background trigger HTTP ' + triggerResponse.status);
      result.rerunStarted = true;
      result.newJobId = newJobId;
    } catch (err) {
      console.warn('verify-fix: rerun trigger failed:', err.message);
      await supabase.saveError(newJobId, 'Auto re-run trigger failed: ' + err.message).catch(function () {});
      result.rerunError = 'Could not start the re-run automatically. Please use the re-run button.';
    }
  }

  return json(200, result);
};
