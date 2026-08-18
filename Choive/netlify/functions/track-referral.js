// track-referral.js
// Tracks referrals when a new user arrives via a referral link
// URL pattern: choive.com/?ref=abc123 (where abc123 is the referrer's jobId)
// POST { referrerJobId, newEmail, newJobId }
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { realtime: { transport: ws } });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  
  if (event.httpMethod === 'POST') {
    // Track a new referral
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (_) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON' })
      };
    }
    
    const { referrerJobId, newEmail, newJobId } = body;
    
    if (!referrerJobId || !newEmail) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing referrerJobId or newEmail' })
      };
    }
    
    try {
      const supabase = getSupabase();
      
      // Store the referral in a referrals table
      const { error } = await supabase
        .from('referrals')
        .insert({
          referrer_job_id: referrerJobId,
          referred_email: newEmail.toLowerCase().trim(),
          referred_job_id: newJobId || null,
          created_at: new Date().toISOString(),
          converted: false,  // Will be set to true when they pay
          reward_claimed: false
        });
      
      if (error) {
        console.error('track-referral insert error:', error.message);
        // Don't fail if referrals table doesn't exist yet - just log
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, tracked: false, message: 'Referral table not ready' })
        };
      }
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, tracked: true })
      };
    } catch (err) {
      console.error('track-referral error:', err);
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal server error' })
      };
    }
  }
  
  if (event.httpMethod === 'GET') {
    // Get referral stats for a user
    const params = event.queryStringParameters || {};
    const jobId = params.jobId;
    
    if (!jobId) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing jobId parameter' })
      };
    }
    
    try {
      const supabase = getSupabase();
      
      const { data, error } = await supabase
        .from('referrals')
        .select('*')
        .eq('referrer_job_id', jobId);
      
      if (error) {
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ totalReferrals: 0, convertedReferrals: 0, referrals: [] })
        };
      }
      
      const referrals = data || [];
      const converted = referrals.filter(r => r.converted).length;
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalReferrals: referrals.length,
          convertedReferrals: converted,
          referrals: referrals.map(r => ({
            email: r.referred_email,
            createdAt: r.created_at,
            converted: r.converted
          }))
        })
      };
    } catch (err) {
      console.error('track-referral get error:', err);
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal server error' })
      };
    }
  }
  
  return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
};
