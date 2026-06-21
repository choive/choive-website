-- CHOIVE™ Diagnostics Table
-- Run this in your Supabase SQL editor
 
create extension if not exists pgcrypto;
 
create table if not exists diagnostics (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  status text not null default 'queued'
    check (status in (
      'queued',
      'collecting_evidence',
      'scoring',
      'complete',
      'failed'
    )),
  stage text
    check (
      stage in (
        'collecting_evidence',
        'scoring',
        'preparing_result'
      )
      or stage is null
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  input jsonb,
  evidence jsonb,
  result jsonb,
  error jsonb,
  -- Payment status — written by verify-payment.js after a Stripe Checkout
  -- session is confirmed as paid (markDiagnosticPaid in lib/supabase.js),
  -- and read by get-result.js / get-diagnostic.js so reopening a shared
  -- result link after payment correctly stays unlocked instead of
  -- re-showing the paywall.
  paid boolean not null default false,
  paid_at timestamptz
);
 
-- Safe to re-run: adds the columns above if this table was created before
-- they existed, without touching any existing data.
alter table diagnostics add column if not exists paid boolean not null default false;
alter table diagnostics add column if not exists paid_at timestamptz;
 
create index if not exists diagnostics_job_id_idx on diagnostics(job_id);
create index if not exists diagnostics_status_idx on diagnostics(status);
create index if not exists diagnostics_created_at_idx on diagnostics(created_at desc);
create index if not exists diagnostics_paid_idx on diagnostics(paid);
 
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
 
drop trigger if exists diagnostics_updated_at on diagnostics;
 
create trigger diagnostics_updated_at
before update on diagnostics
for each row
execute function update_updated_at();
 
