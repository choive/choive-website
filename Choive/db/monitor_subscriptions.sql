-- CHOIVE™ — Score monitoring subscriptions
-- One-time migration. Run this in the Supabase SQL editor (or via `supabase db`)
-- before enabling the monitoring feature. Uses the same project as the
-- `diagnostics` and `leads` tables.

create table if not exists monitor_subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null,
  -- The diagnostic being watched, and its stable business identity so a
  -- re-check can be linked to the same business over time.
  job_id                text not null,
  business_fingerprint  text,
  business_name         text,
  -- Cadence + sensitivity
  frequency             text not null default 'weekly',   -- 'weekly' | 'monthly'
  threshold             int  not null default 5,          -- min |delta| to alert
  -- State
  baseline_score        int,                              -- score at subscribe time
  last_score            int,                              -- most recent checked score
  last_checked_at       timestamptz,
  next_check_at         timestamptz not null default now(),
  active                boolean not null default true,
  confirmed             boolean not null default false,   -- double opt-in
  confirm_token         text not null,
  unsubscribe_token     text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_monitor_due
  on monitor_subscriptions (next_check_at)
  where active = true and confirmed = true;

create index if not exists idx_monitor_email
  on monitor_subscriptions (email);

create index if not exists idx_monitor_confirm_token
  on monitor_subscriptions (confirm_token);

create index if not exists idx_monitor_unsub_token
  on monitor_subscriptions (unsubscribe_token);

-- Prevent duplicate active subscriptions for the same email+diagnostic.
create unique index if not exists uniq_monitor_email_job
  on monitor_subscriptions (email, job_id);
