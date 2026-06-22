// lib/supabase.js
// Supabase client + diagnostic record helpers
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { realtime: { transport: ws } });
}

async function createDiagnostic(jobId, input) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .insert({
      job_id: jobId,
      status: 'queued',
      stage: null,
      input,
      evidence: null,
      result: null,
      error: null
    });
  if (error) throw new Error('Supabase insert failed: ' + error.message);
}

async function updateStatus(jobId, status, stage) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ status: status, stage: stage || null })
    .eq('job_id', jobId);
  if (error) throw new Error('Supabase update failed: ' + error.message);
}

async function saveEvidence(jobId, evidence) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ evidence: evidence, status: 'scoring', stage: 'scoring' })
    .eq('job_id', jobId);
  if (error) throw new Error('Supabase evidence save failed: ' + error.message);
}

async function saveResult(jobId, result) {
  const supabase = getClient();
  const { error } = await supabase
    .from('diagnostics')
    .update({ result: result, status: 'complete', stage: 'preparing_result' })
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
    .select('job_id, status, stage, input, result, error, paid, paid_at, created_at, updated_at')
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
    .update({
      paid: true,
      paid_at: new Date().toISOString()
    })
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

// Save email lead capture — from free result form or post-payment
// Best-effort: errors are logged but never thrown to callers
async function saveLead(opts) {
  var email = (opts.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('saveLead: invalid email');
  }
  const supabase = getClient();
  const { error } = await supabase
    .from('leads')
    .upsert({
      email:     email,
      job_id:    opts.jobId    || null,
      source:    opts.source   || 'unknown',
      name:      opts.name     || '',
      amount:    opts.amount   || 0,
      currency:  opts.currency || 'eur',
      created_at: new Date().toISOString()
    }, { onConflict: 'email' });
  if (error) throw new Error('Supabase saveLead failed: ' + error.message);
}

module.exports = {
  createDiagnostic,
  updateStatus,
  saveEvidence,
  saveResult,
  saveError,
  getDiagnostic,
  markDiagnosticPaid,
  saveLead
};
