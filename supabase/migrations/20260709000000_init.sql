-- Schema contract (SPEC §3). Single user; all timestamps timestamptz UTC.
-- Access model: RLS enabled on every table with no policies = deny-all for
-- anon/authenticated keys. All legitimate access uses the service-role key
-- (which bypasses RLS) or the Edge Function (shared-secret protected).

-- Audit/reprocessing trail: every ingestion request body lands here untouched
-- before parsing, so every downstream table is rebuildable.
create table raw_payloads (
  id          bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  payload     jsonb
);

create table workouts (
  id          uuid primary key default gen_random_uuid(),
  external_id text unique not null, -- Health Auto Export workout id; upsert key
  type        text,                 -- swimming, cycling, traditional_strength_training, elliptical, surfing, walking, other
  start_at    timestamptz,
  end_at      timestamptz,
  duration_s  int,
  distance_m  numeric,
  energy_kcal numeric,
  avg_hr      numeric,
  max_hr      numeric,
  source      text default 'apple_watch',
  raw         jsonb
);

create index workouts_start_at_idx on workouts (start_at);
create index workouts_type_idx on workouts (type);

create table workout_hr_samples (
  workout_id uuid not null references workouts (id) on delete cascade,
  offset_s   int not null,
  bpm        smallint not null,
  primary key (workout_id, offset_s)
);

-- One row per calendar date (local date derived from timestamps at ingestion).
-- Upsert semantics: new values overwrite nulls / newer data wins per column.
create table daily_metrics (
  date                  date primary key,
  resting_hr            numeric,
  hrv_sdnn_ms           numeric,
  respiratory_rate      numeric,
  sleep_start           timestamptz,
  sleep_end             timestamptz,
  sleep_duration_min    numeric,
  sleep_stages          jsonb,
  vo2max                numeric,
  steps                 int,
  active_energy_kcal    numeric,
  wrist_temp_deviation_c numeric,
  state_of_mind         jsonb
);

-- Single row of user configuration.
create table user_config (
  id                  smallint primary key default 1 check (id = 1),
  hr_max              smallint, -- init: highest observed max_hr; nightly job raises if exceeded
  swim_hr_offset      smallint default -10,
  zone2_low_frac      numeric default 0.60,
  zone2_high_frac     numeric default 0.70,
  weekly_min_sessions jsonb default '{"swim":2,"lift":2}',
  timezone            text default 'UTC'
);

insert into user_config (id) values (1);

-- Written by the nightly metrics job.
create table computed_workout (
  workout_id     uuid primary key references workouts (id) on delete cascade,
  time_in_zones  jsonb,   -- seconds in zones 1–5
  trimp          numeric,
  ef             numeric,
  decoupling_pct numeric,
  hrr60          numeric,
  computed_at    timestamptz
);

create table computed_daily (
  date             date primary key,
  trimp_total      numeric default 0,
  ctl              numeric,
  atl              numeric,
  tsb              numeric,
  acwr             numeric,
  rhr_baseline_60d numeric,
  rhr_dev          numeric,
  hrv_baseline_60d numeric,
  hrv_dev          numeric,
  -- array of {type, message, severity}; only acwr_high | rhr_elevated | week_minimum_missed
  flags            jsonb default '[]',
  computed_at      timestamptz
);

-- Exploratory layer; overwritten each nightly run.
create table insight_correlations (
  computed_at timestamptz,
  var_x       text not null,
  var_y       text not null,
  lag_days    smallint not null,
  r           numeric,
  n           int,
  p_value     numeric,
  primary key (var_x, var_y, lag_days)
);

-- Confirmatory layer (e.g. ef_on_sleep_dlm).
create table insight_models (
  name         text primary key,
  computed_at  timestamptz,
  spec         text,
  coefficients jsonb,
  diagnostics  jsonb -- n, r², CIs, notes
);

create table chat_sessions (
  id                uuid primary key default gen_random_uuid(),
  started_at        timestamptz default now(),
  title             text,
  claude_session_id text,
  messages          jsonb default '[]' -- [{role, content, ts}]
);

-- RLS: enable everywhere, define no policies → deny-all for anon/authenticated.
alter table raw_payloads         enable row level security;
alter table workouts             enable row level security;
alter table workout_hr_samples   enable row level security;
alter table daily_metrics        enable row level security;
alter table user_config          enable row level security;
alter table computed_workout     enable row level security;
alter table computed_daily       enable row level security;
alter table insight_correlations enable row level security;
alter table insight_models       enable row level security;
alter table chat_sessions        enable row level security;
