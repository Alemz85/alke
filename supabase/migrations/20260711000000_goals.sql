-- Goals: high-level goal cards on the Profile tab. A goal is a reference for
-- tracking progress (and context for the chat agent) — creating one does NOT
-- generate plans or other artifacts. Same access model as injuries: RLS
-- deny-all, service role bypasses; the chat agent maintains goals via
-- chatctx/goals.py, the app writes user-created cards via the main process.
--
-- The progress curve is AI-built: the chat agent authors metric_sql (a
-- SELECT returning columns (date, value), one row per day) which is evaluated
-- through the hardened exec_readonly_sql RPC — by goals.py recompute on
-- creation/backfill and by the nightly metrics job for active goals — and the
-- resulting series is materialized into goal_progress.

create table goals (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,           -- unstructured prose; user-written and/or AI-polished
  status        text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  started_at    date not null default current_date,
  duration_days integer check (duration_days > 0), -- null = open-ended
  created_by    text not null default 'user' check (created_by in ('user', 'chat')),

  -- AI-built progress metric. All nullable: a goal exists before its metric
  -- does (the agent fills these in after card creation).
  metric_name        text,      -- short label, e.g. "Weekly Zone 2 minutes (4-wk avg)"
  metric_description text,      -- how it's computed and why it summarizes this goal
  metric_sql         text,      -- SELECT (date, value) — evaluated via exec_readonly_sql only
  metric_direction   text check (metric_direction in ('up', 'down')), -- which way is progress
  metric_unit        text,      -- display unit, e.g. "min/wk", "kg"
  metric_baseline    numeric,   -- value around started_at (progress reference point)
  metric_target      numeric,   -- null when the goal has no crisp numeric target

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Materialized progress series, one point per day per goal. Upserted (never
-- appended blindly) so recomputes and nightly reruns are idempotent.
create table goal_progress (
  goal_id     uuid not null references goals (id) on delete cascade,
  date        date not null,
  value       numeric not null,
  computed_at timestamptz default now(),
  primary key (goal_id, date)
);

alter table goals         enable row level security;
alter table goal_progress enable row level security;
