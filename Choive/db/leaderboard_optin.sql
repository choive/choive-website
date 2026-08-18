-- CHOIVE™ — Public leaderboard opt-in
-- One-time migration. Run this in the Supabase SQL editor (or via `supabase db`)
-- BEFORE the public leaderboard can show a business by its real name.
--
-- By default NO business is named on the leaderboard: the get-leaderboard
-- function shows every qualifying business anonymously (for example
-- "A dental clinic in Leeds"). A business only appears by name after the owner
-- turns this flag on. The function still works if this column is missing — it
-- simply treats everyone as not opted in — so running this migration is safe
-- and can be done at any time.

alter table diagnostics
  add column if not exists leaderboard_optin boolean not null default false;

-- Speeds up the leaderboard query, which reads only complete + paid rows.
create index if not exists idx_diagnostics_leaderboard
  on diagnostics (status, paid)
  where status = 'complete' and paid = true;
