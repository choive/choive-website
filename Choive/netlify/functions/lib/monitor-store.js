// lib/monitor-store.js
// CHOIVE™ — Supabase data layer for score monitoring subscriptions.
// Kept isolated from the core engine's lib/supabase.js so the monitoring
// feature can never affect the diagnostic pipeline.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Requires table `monitor_subscriptions` (see db/monitor_subscriptions.sql).

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

// Days until the next check for a given cadence.
function cadenceDays(frequency) {
  return frequency === 'monthly' ? 30 : 7;
}

function nextCheckDate(frequency, from) {
  const base = from ? new Date(from) : new Date();
  base.setUTCDate(base.getUTCDate() + cadenceDays(frequency));
  return base.toISOString();
}

// Create (or reactivate) a subscription. Double opt-in: starts unconfirmed.
// Returns { id, confirmToken, unsubscribeToken, alreadyConfirmed }.
async function createSubscription(opts) {
  const supabase = getClient();
  const row = {
    email:                opts.email,
    job_id:               opts.jobId,
    business_fingerprint: opts.fingerprint || null,
    business_name:        opts.businessName || null,
    frequency:            opts.frequency,
    threshold:            opts.threshold,
    baseline_score:       (typeof opts.baselineScore === 'number') ? opts.baselineScore : null,
    last_score:           (typeof opts.baselineScore === 'number') ? opts.baselineScore : null,
    last_checked_at:      new Date().toISOString(),
    next_check_at:        nextCheckDate(opts.frequency),
    active:               true,
    confirmed:            false,
    confirm_token:        token(),
    unsubscribe_token:    token(),
    updated_at:           new Date().toISOString()
  };

  // Upsert on (email, job_id) so re-subscribing refreshes rather than errors.
  const { data, error } = await supabase
    .from('monitor_subscriptions')
    .upsert(row, { onConflict: 'email,job_id' })
    .select('id, confirm_token, unsubscribe_token, confirmed')
    .single();
  if (error) throw new Error('createSubscription failed: ' + error.message);
  return {
    id: data.id,
    confirmToken: data.confirm_token,
    unsubscribeToken: data.unsubscribe_token,
    alreadyConfirmed: data.confirmed === true
  };
}

async function confirmByToken(confirmToken) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('monitor_subscriptions')
    .update({ confirmed: true, active: true, updated_at: new Date().toISOString() })
    .eq('confirm_token', confirmToken)
    .select('id, email, business_name')
    .maybeSingle();
  if (error) throw new Error('confirmByToken failed: ' + error.message);
  return data || null;
}

async function deactivateByToken(unsubscribeToken) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('monitor_subscriptions')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('unsubscribe_token', unsubscribeToken)
    .select('id, email')
    .maybeSingle();
  if (error) throw new Error('deactivateByToken failed: ' + error.message);
  return data || null;
}

// Subscriptions that are active, confirmed, and due for a check.
async function getDueSubscriptions(limit) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('monitor_subscriptions')
    .select('*')
    .eq('active', true)
    .eq('confirmed', true)
    .lte('next_check_at', new Date().toISOString())
    .order('next_check_at', { ascending: true })
    .limit(limit || 50);
  if (error) throw new Error('getDueSubscriptions failed: ' + error.message);
  return data || [];
}

// Record the outcome of a check and schedule the next one.
async function recordCheck(id, newScore, frequency) {
  const supabase = getClient();
  const { error } = await supabase
    .from('monitor_subscriptions')
    .update({
      last_score:      newScore,
      last_checked_at: new Date().toISOString(),
      next_check_at:   nextCheckDate(frequency),
      updated_at:      new Date().toISOString()
    })
    .eq('id', id);
  if (error) throw new Error('recordCheck failed: ' + error.message);
}

module.exports = {
  createSubscription,
  confirmByToken,
  deactivateByToken,
  getDueSubscriptions,
  recordCheck,
  nextCheckDate,
  cadenceDays
};
