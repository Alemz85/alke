-- Manual protein tracker: one daily-total row per date, additive per entry.
-- The app never inserts partial-day rows for "meals" — grams accumulate onto
-- the day's single row via an incrementing upsert (db.ts addProtein), so
-- "40g at lunch, +40g at dinner" becomes one row {grams: 80}. Same
-- access model as gym/injuries/goals: RLS deny-all, service role bypasses;
-- the app writes via main-process helpers.
create table if not exists protein_log (
  log_date   date primary key,
  grams      numeric(6,1) not null default 0 check (grams >= 0),
  updated_at timestamptz not null default now()
);

alter table protein_log enable row level security;
