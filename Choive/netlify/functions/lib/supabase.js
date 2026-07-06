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
function buildFingerprint(input) {
  var name     = String(input.name     || '').toLowerCase().trim().replace(/\s+/g, '');
  var category = String(input.category || '').toLowerCase().trim().replace(/\s+/g, '');
  var city     = String(input.city     || '').toLowerCase().trim().replace(/\s+/g, '');
  var raw      = name + '|' + category + '|' + city;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
async function createDiagnostic(jobId, input, ipHash) {
  const supabase = getClient();
  const fingerprint = buildFingerprint(input);
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
      version:              1
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
// Looks up the most recent COMPLETE diagnostic for this business fingerprint,
// if it was created within the cache window. Used to avoid re-fetching live
// evidence (Serper/website/Apify) on every run for the same business — this
// is what makes repeated runs of the same business return a stable score.
async function getCachedEvidence(fingerprint, maxAgeHours) {
  const supabase = getClient();
  const cutoff = new Date(Date.now() - (maxAgeHours || 24) * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('job_id, evidence, created_at')
    .eq('business_fingerprint', fingerprint)
    .eq('status', 'complete')
    .not('evidence', 'is', null)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('getCachedEvidence failed:', error.message);
    return null;
  }
  return data;
}
// Returns the competitor name identified in the most recent complete diagnostic
// for this business fingerprint. Used to stabilise competitor identification
// across runs — prevents Semrush→Profound type drift between cached windows.
async function getPreviousCompetitor(fingerprint) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('diagnostics')
    .select('result')
    .eq('business_fingerprint', fingerprint)
    .eq('status', 'complete')
    .not('result', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('getPreviousCompetitor failed:', error.message);
    return null;
  }
  if (!data || !data.result) return null;
  var result = data.result;
  // Check competitors array first
  var competitors = Array.isArray(result.competitors) ? result.competitors : [];
  if (competitors.length > 0 && competitors[0] && competitors[0].name) {
    return String(competitors[0].name).trim() || null;
  }
  // Fallback: check displacement object
  var disp = (result.displacement && typeof result.displacement === 'object') ? result.displacement : {};
  return (disp.competitorName && String(disp.competitorName).trim()) || null;
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
    .select('job_id, status, stage, input, result, error, paid, paid_at, business_fingerprint, parent_job_id, version, created_at, updated_at')
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) throw new Error('Supabase fetch failed: ' + error.message);
  return data;
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

module.exports = {
  createDiagnostic,
  countDiagnosticsToday,
  createDiagnosticWithParent,
  getDiagnosticHistory,
  updateStatus,
  saveEvidence,
  saveResult,
  saveError,
  getDiagnostic,
  markDiagnosticPaid,
  saveLead,
  buildFingerprint,
  getCachedEvidence,
  getPreviousCompetitor,
  getPreviousResult
};
