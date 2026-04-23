-- CHOIVE™ Diagnostics Table
-- Run this in your Supabase SQL editor

create extension if not exists pgcrypto;

create table if not exists diagnostics (
  id            uuid primary key default gen_random_uuid(),
  job_id        text not null unique,
  status        text not null default 'queued'
                check (status in (
                  'queued',
                  'collecting_evidence',
                  'scoring',
                  'complete',
                  'failed'
                )),
  stage         text
                check (
                  stage in (
                    'collecting_evidence',
                    'scoring',
                    'preparing_result'
                  )
                  or stage is null
                ),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  input         jsonb,
  evidence      jsonb,
  result        jsonb,
  error         jsonb
);

create index if not exists diagnostics_job_id_idx on diagnostics(job_id);
create index if not exists diagnostics_status_idx on diagnostics(status);
create index if not exists diagnostics_created_at_idx on diagnostics(created_at desc);

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
