-- referrals.sql
-- Referral tracking for CHOIVE
-- Run this in your Supabase SQL editor to create the referrals table

CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  referrer_job_id TEXT NOT NULL,
  referred_email TEXT NOT NULL,
  referred_job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted BOOLEAN NOT NULL DEFAULT FALSE,
  converted_at TIMESTAMPTZ,
  reward_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  reward_claimed_at TIMESTAMPTZ
);

-- Index for fast lookups by referrer
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_job_id);

-- Index for checking if an email was referred
CREATE INDEX IF NOT EXISTS idx_referrals_email ON referrals(referred_email);

-- Enable Row Level Security (optional - adjust policies based on your needs)
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Policy: allow service role full access (used by Netlify functions)
CREATE POLICY "Service role has full access" ON referrals
  FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE referrals IS 'Tracks user referrals for CHOIVE diagnostics';
COMMENT ON COLUMN referrals.referrer_job_id IS 'Job ID of the user who referred someone';
COMMENT ON COLUMN referrals.referred_email IS 'Email of the person who was referred';
COMMENT ON COLUMN referrals.referred_job_id IS 'Job ID created by the referred user (if they ran a diagnostic)';
COMMENT ON COLUMN referrals.converted IS 'True when the referred user pays for their first diagnostic';
COMMENT ON COLUMN referrals.reward_claimed IS 'True when the referrer claims their reward';
