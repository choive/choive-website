// lib/supabase.js
// CHOIVE™ Supabase client + diagnostic record helpers
// ENV:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

let supabaseInstance = null;

function getClient() {
  if (supabaseInstance) return supabaseInstance;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  supabaseInstance = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return supabaseInstance;
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

  if (error) {
    throw new Error(`Supabase createDiagnostic failed: ${error.message}`);
  }
}

async function updateStatus(jobId, status, stage = null) {
  const supabase = getClient();

  const { data, error } = await supabase
    .from('diagnostics')
    .update({
      status,
      stage
    })
    .eq('job_id', jobId)
    .select('job_id')
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase updateStatus failed: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Diagnostic not found for job_id: ${jobId}`);
  }
}

async function saveEvidence(jobId, evidence) {
  const supabase = getClient();

  const { data, error } = await supabase
    .from('diagnostics')
    .update({
      evidence,
      status: 'scoring',
      stage: 'scoring',
      error: null
    })
    .eq('job_id', jobId)
    .select('job_id')
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase saveEvidence failed: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Diagnostic not found for job_id: ${jobId}`);
  }
}

async function saveResult(jobId, result) {
  const supabase = getClient();

  const { data, error } = await supabase
    .from('diagnostics')
    .update({
      result,
      status: 'complete',
      stage: null,
      error: null
    })
    .eq('job_id', jobId)
    .select('job_id')
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase saveResult failed: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Diagnostic not found for job_id: ${jobId}`);
  }
}

async function markDiagnosticFailed(jobId, errorPayload) {
  const supabase = getClient();

  const normalizedError =
    typeof errorPayload === 'string'
      ? {
          message: errorPayload,
          timestamp: new Date().toISOString()
        }
      : {
          ...errorPayload,
          timestamp: errorPayload?.timestamp || new Date().toISOString()
        };

  const { data, error } = await supabase
    .from('diagnostics')
    .update({
      status: 'failed',
      stage: null,
      error: normalizedError
    })
    .eq('job_id', jobId)
    .select('job_id')
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase markDiagnosticFailed failed: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Diagnostic not found for job_id: ${jobId}`);
  }
}

async function getDiagnostic(jobId) {
  const supabase = getClient();

  const { data, error } = await supabase
    .from('diagnostics')
    .select(`
      job_id,
      status,
      stage,
      input,
      evidence,
      result,
      error,
      created_at,
      updated_at
    `)
    .eq('job_id', jobId)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase getDiagnostic failed: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return data;
}

module.exports = {
  getClient,
  createDiagnostic,
  updateStatus,
  saveEvidence,
  saveResult,
  markDiagnosticFailed,
  getDiagnostic
};
