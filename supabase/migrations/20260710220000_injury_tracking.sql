-- Injury tracking v2: structured recovery-plan items + adherence checks, and
-- context/workout linkage on injury notes. Same access model as injuries:
-- RLS deny-all, service role bypasses; the chat agent maintains plan items via
-- injuries.py, the app writes user quick logs and checks via the main process.

-- Structured plan items (replaces relying on the recovery_plan markdown blob
-- as the only plan representation; the markdown stays as the "approach" prose).
create table recovery_plan_items (
  id            uuid primary key default gen_random_uuid(),
  injury_id     uuid not null references injuries (id) on delete cascade,
  name          text not null,              -- e.g. "Tibialis raises"
  kind          text not null default 'exercise' check (kind in ('exercise','habit','constraint')),
  weekly_target smallint check (weekly_target between 1 and 14), -- null for constraints
  note          text,                       -- dosage/cue, e.g. "3x15, slow eccentric"
  active        boolean not null default true, -- deactivate instead of delete (history keeps meaning)
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index recovery_plan_items_injury_idx on recovery_plan_items (injury_id, active);

-- One row = "this item was done on this date". Unique per day: a second tap
-- the same day is a no-op/uncheck, not a double count. source 'gym' reserved
-- for the future lifting tab's automatic matching.
create table plan_item_checks (
  id         bigint generated always as identity primary key,
  item_id    uuid not null references recovery_plan_items (id) on delete cascade,
  done_date  date not null default current_date,
  source     text not null default 'user' check (source in ('user','chat','gym')),
  created_at timestamptz default now(),
  unique (item_id, done_date)
);

create index plan_item_checks_item_idx on plan_item_checks (item_id, done_date desc);

-- Quick-log context tags (values validated app-side: during_workout,
-- post_workout, at_rest, on_waking) and optional link to the workout that
-- a during/post-workout flare refers to.
alter table injury_notes
  add column context    text[],
  add column workout_id uuid references workouts (id) on delete set null;

alter table recovery_plan_items enable row level security;
alter table plan_item_checks    enable row level security;
