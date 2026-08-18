-- CHOIVE™ — API keys + daily usage
-- One-time migration. Run this in the Supabase SQL editor (or via `supabase db`)
-- BEFORE handing out API access. Same project as the `diagnostics` table.
--
-- We NEVER store the raw API key. We store only its SHA-256 hash, exactly like
-- a password. When someone calls the API we hash the key they send and match it
-- against key_hash. If the database ever leaked, the real keys stay safe.

create table if not exists api_keys (
  id            uuid primary key default gen_random_uuid(),
  -- SHA-256 hash of the real key (hex). The raw key is shown to the owner once
  -- at creation time and never stored.
  key_hash      text not null unique,
  -- A friendly label so you know who a key belongs to.
  label         text not null default '',
  active        boolean not null default true,
  -- How many diagnostics this key may start per day.
  daily_limit   int not null default 50,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists idx_api_keys_hash on api_keys (key_hash) where active = true;

-- One row per key per day, counting how many diagnostics that key started.
create table if not exists api_usage (
  id           uuid primary key default gen_random_uuid(),
  api_key_id   uuid not null references api_keys(id) on delete cascade,
  usage_date   date not null default (now() at time zone 'utc')::date,
  count        int not null default 0,
  updated_at   timestamptz not null default now()
);

create unique index if not exists uniq_api_usage_key_day
  on api_usage (api_key_id, usage_date);

-- ── How to create a key (run once per customer) ──────────────────────────────
-- 1. Make a random key locally, for example:  openssl rand -hex 24
-- 2. Hash it:  echo -n "THE_KEY" | shasum -a 256
-- 3. Insert the HASH (never the raw key):
--      insert into api_keys (key_hash, label, daily_limit)
--      values ('<sha256-hash-here>', 'Acme Corp', 100);
-- 4. Send the raw key to the customer over a secure channel. It is never
--    recoverable from the database — if lost, issue a new one.
