// lib/supabase.js
// CHOIVE™ Supabase client + all database helpers
// Includes: longitudinal tracking via business_fingerprint + parent_job_id
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const crypto = require('crypto');
function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { realtime: { transport: ws } });
}
// Creates a fingerprint from business name + category + city
// Used to link diagnostics for the same business over time
// Identity for continuity/caching. A website domain is a far more stable key
// than free-text category/city wording \u2014 two different people describing
// the identical business ("premium grass-fed beef" vs "direct-to-consumer
// beef delivery") produce different hashes under text-only matching, silently
// losing all continuity (competitor identity, evidence cache, progress
// tracking) even though it's obviously the same business. When a website is
// provided, the normalized domain is the stable identity base. Subject type
// and market reach remain part of the measurement identity so a product audit
// is never compared with a company audit, and a local audit is never compared
// with a global one.
function normalizeDomain(url) {
  var u = String(url || '').trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  u = u.split('/')[0].split('?')[0].split('#')[0];
  return u;
}

function buildFingerprint(input) {
  var domain = normalizeDomain(input.website);
  var subjectType = String(input.subjectType || 'business').toLowerCase().trim();
  var marketReach = String(input.marketReach || '').toLowerCase().trim();
  var measurement = '|subject:' + subjectType + '|reach:' + marketReach;
  if (domain) {
    return crypto.createHash('sha256').update('domain:' + domain + measurement).digest('hex').slice(0, 32);
  }
  // Category is deliberately EXCLUDED from the fallback identity: it's free
  // text, and two different people describing the same business (or the same
  // person on different days) will phrase it differently \u2014 "premium beef
  // delivery" vs "Direct-to-consumer grass-fed beef" fractures what should be
  // one continuous identity into two disconnected ones, each internally
  // consistent but silently unaware of the other (confirmed live: Taurbull
  // run by two people landed on two different, independently-locked
  // competitors). Name + city alone is a far more stable proxy for "is this
  // the same real-world business" than any free-text category ever will be.
  var name = String(input.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
  var city = String(input.city || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
  var raw  = name + '|' + city + measurement;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
// Generates a URL-safe slug from a business name.
// "Nike Sportswear" -> "nike-sportswear", "Café Paris" -> "cafe-paris"
function buildSlugBase(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip diacritics (e.g. é->e)
    .replace(/[^a-z0-9\s\-]/g, '')                     // keep letters, digits, spaces, hyphens
    .trim()
    .replace(/\s+/g, '-')                               // spaces -> hyphens
    .replace(/-+/g, '-')                                // collapse multiple hyphens
    .slice(0, 60);                                      // max length
}

// Returns a unique slug. After one base-slug lookup, repeated diagnostics use
// a short job-id suffix. Never scan `-2`, `-3`, ... sequentially: popular or
// repeatedly tested businesses can otherwise exhaust the start function's
// execution window before the diagnostic row is created.
async function generateUniqueSlug(supabase, name, uniqueSuffix) {
  var base = buildSlugBase(name);
  if (!base) return null;
  var { data: existing } = await supabase
    .from('diagnostics').select('slug').eq('slug', base).maybeSingle();
  if (!existing) return base;
  var suffix = String(uniqueSuffix || crypto.randomBytes(4).toString('hex'))
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return base.slice(0, Math.max(1, 60 - suffix.length - 1)) + '-' + suffix;
}

async function createDiagnostic(jobId, input, ipHash) {
  const supabase = getClient();
  const fingerprint = buildFingerprint(input);
  var slug = null;
  try { slug = await generateUniqueSlug(supabase, input.name, jobId); }
  catch (e) { console.warn('createDiagnostic: slug generation failed (non-critical):', e.message); }
  const { error } = await supabase
    .from('diagnostics')
    .insert({
      job_id:               jobId,
      status:               'queued',
      stage:                null,
      ip_hash:              ipHash || null,
      input,
      evidence:             null,
      result:               null,
      error:                null,
      business_fingerprint: fingerprint,
      parent_job_id:        null,
      version:              1,
      slug:                 slug
    });
  if (error) throw new Error('Supabase insert failed: ' + error.message);
}
// Used by rerun-diagnostic.js — links new diagnostic to original
async function createDiagnosticWithParent(jobId, input, parentJobId) {
  const supabase = getClient();
  const fingerprint = buildFingerprint(input);
  // Find the version number — count existing diagnostics with same fingerprint
  const { data: existing } = await supabase
    .from('diagnostics')
    .select('version')
    .eq('business_fingerprint', fingerprint)
    .order('version', { ascending: false })
    .limit(1);
  var nextVersion = (existing && existing.length > 0)
    ? ((existing[0].version || 1) + 1) : 2;
  const { error } = await supabase
    .from('diagnostics')
    .insert({
      job_id:               jobId,
      status:               'queued',
      stage:                null,
      input,
      evidence:             null,
      result:               null,
      error:                null,
      paid:                 true,
      paid_at:              new Date().toISOString(),
      business_fingerprint: fingerprint,
      parent_job_id:        parentJobId,
      version:              nextVersion
    });
  if (error) throw new Error('Supabase insert (with parent) failed: ' + error.message);
}
// Returns all diagnostics for the same business fingerprint — score history
async function getDiagnosticHistory(fingerprint) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('job_id, version, status, result, paid, created_at')
    .eq('business_fingerprint', fingerprint)
    .eq('status', 'complete')
    .order('version', { ascending: true });
  if (error) throw new Error('Supabase history fetch failed: ' + error.message);
  return data || [];
}
async function updateStatus(jobId, status, stage) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ status, stage: stage || null })
    .eq('job_id', jobId);
  if (error) throw new Error('Supabase update failed: ' + error.message);
}
async function saveEvidence(jobId, evidence) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ evidence, status: 'scoring', stage: 'scoring' })
    .eq('job_id', jobId);
  if (error) throw new Error('Supabase evidence save failed: ' + error.message);
}
async function saveResult(jobId, result) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ result, status: 'complete', stage: 'preparing_result' })
    .eq('job_id', jobId);
  if (error) throw new Error('Supabase result save failed: ' + error.message);
}

async function updateDiagnosticResult(jobId, result) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ result })
    .eq('job_id', jobId);
  if (error) throw new Error('Supabase result update failed: ' + error.message);
}
async function saveError(jobId, errorMessage) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({
      status: 'failed',
      error: { message: errorMessage, timestamp: new Date().toISOString() }
    })
    .eq('job_id', jobId);
  if (error) console.error('Supabase error save failed:', error.message);
}
async function getDiagnostic(jobId) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('job_id, status, stage, input, result, error, paid, paid_at, report_sent_at, business_fingerprint, parent_job_id, version, created_at, updated_at')
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) throw new Error('Supabase fetch failed: ' + error.message);
  return data;
}
async function markReportSent(jobId) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ report_sent_at: new Date().toISOString() })
    .eq('job_id', jobId);
  if (error) throw new Error('Supabase markReportSent failed: ' + error.message);
}
async function markDiagnosticPaid(jobId) {
  if (!jobId || typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('markDiagnosticPaid: jobId is missing or malformed');
  }
  const supabase = getClient();
  const { data, error } = await supabase
    .from('diagnostics')
    .update({ paid: true, paid_at: new Date().toISOString() })
    .eq('job_id', jobId)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error('markDiagnosticPaid: no diagnostic found for jobId ' + jobId);
    }
    throw new Error('Supabase markDiagnosticPaid failed: ' + error.message);
  }
  return data;
}
async function saveLead(opts) {
  var email = (opts.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('saveLead: invalid email');
  const supabase = getClient();
  const { error } = await supabase
    .from('leads')
    .upsert({
      email,
      job_id:    opts.jobId    || null,
      source:    opts.source   || 'unknown',
      name:      opts.name     || '',
      amount:    opts.amount   || 0,
      currency:  opts.currency || 'eur',
      created_at: new Date().toISOString()
    }, { onConflict: 'email' });
  if (error) throw new Error('Supabase saveLead failed: ' + error.message);
}
// Most recent COMPLETED diagnostic for this business — result + evidence +
// timestamps. Powers the verification engine: every re-run is compared against
// this row to prove (or disprove) that the prescribed fixes moved the score.
async function getPreviousResult(fingerprint) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('job_id, result, evidence, created_at')
    .eq('business_fingerprint', fingerprint)
    .eq('status', 'complete')
    .not('result', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('getPreviousResult failed:', error.message);
    return null;
  }
  return data || null;
}

// Daily diagnostic counts for durable rate limiting. ipHash null = global.
// Fails open: on any error returns 0 so an outage never blocks real users.
async function countDiagnosticsToday(ipHash) {
  try {
    const supabase = getClient();
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    let q = supabase
      .from('diagnostics')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', dayStart.toISOString());
    if (ipHash) q = q.eq('ip_hash', ipHash);
    const { count, error } = await q;
    if (error) { console.warn('countDiagnosticsToday failed:', error.message); return 0; }
    return count || 0;
  } catch (err) {
    console.warn('countDiagnosticsToday error:', err.message);
    return 0;
  }
}

// Look up a diagnostic by its slug (for the /results/:slug email redirect flow).
async function getDiagnosticBySlug(slug) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('job_id, status, paid, slug')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error('Supabase slug lookup failed: ' + error.message);
  return data || null;
}

// Get just the slug for a known jobId — used by stripe-webhook when building the email link.
async function getSlugForJob(jobId) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('slug')
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) { console.warn('getSlugForJob failed:', error.message); return null; }
  return (data && data.slug) || null;
}

module.exports = {
  createDiagnostic,
  countDiagnosticsToday,
  createDiagnosticWithParent,
  getDiagnosticHistory,
  updateStatus,
  saveEvidence,
  saveResult,
  updateDiagnosticResult,
  saveError,
  getDiagnostic,
  getDiagnosticBySlug,
  getSlugForJob,
  markReportSent,
  markDiagnosticPaid,
  saveLead,
  buildFingerprint,
  getPreviousResult
};
