-- Gym lifting tab (TODO #3): user-logged strength content attached to synced
-- workouts. Same access model as injuries/goals: RLS deny-all, service role
-- bypasses; the app writes via main-process helpers (source='user' hardwired
-- server-side). A chat-agent write helper (chatctx/gym.py) may follow later.

-- Exercise catalog. Grows on first use (autocomplete + create-on-type); rows
-- are never deleted from the UI so set history keeps meaning. name_key gives
-- case-insensitive canonical identity ("Squat" == "squat") — also the future
-- matching target for recovery-plan compliance (TODO #3 integration).
create table exercises (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(name) between 1 and 120),
  name_key     text generated always as (lower(name)) stored unique,
  muscle_group text check (length(muscle_group) <= 40),
  created_at   timestamptz default now()
);

-- Reusable session templates ("Legs A"). Archived instead of deleted so
-- gym_sessions.template_id keeps pointing at them.
create table gym_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 120),
  notes      text,
  archived   boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One line of a template: an exercise plus optional targets ("3x8 @ 60kg").
create table gym_template_exercises (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid not null references gym_templates (id) on delete cascade,
  exercise_id      uuid not null references exercises (id),
  position         smallint not null,
  target_sets      smallint check (target_sets between 1 and 50),
  target_reps      smallint check (target_reps between 1 and 500),
  target_weight_kg numeric(6,2) check (target_weight_kg >= 0),
  note             text
);

create index gym_template_exercises_template_idx on gym_template_exercises (template_id, position);

-- One logged gym session. Dual granularity by design: a row WITHOUT gym_sets
-- is a valid quick log ("did legs, roughly template X"); sets make it a full
-- log. workout_id links the Apple-Health-synced workout row (unique: one log
-- per synced workout); null = logged without a synced workout.
create table gym_sessions (
  id           uuid primary key default gen_random_uuid(),
  workout_id   uuid unique references workouts (id) on delete set null,
  template_id  uuid references gym_templates (id) on delete set null,
  performed_at timestamptz not null default now(),
  title        text check (length(title) <= 120),
  notes        text,
  source       text not null default 'user' check (source in ('user', 'chat')),
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index gym_sessions_performed_idx on gym_sessions (performed_at desc);

-- Per-set detail, ordered by position within the session. Consecutive rows of
-- the same exercise form one display block. weight_kg null = bodyweight.
create table gym_sets (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references gym_sessions (id) on delete cascade,
  exercise_id uuid not null references exercises (id),
  position    smallint not null,
  reps        smallint check (reps between 0 and 500),
  weight_kg   numeric(6,2) check (weight_kg >= 0),
  rpe         numeric(3,1) check (rpe between 1 and 10),
  is_warmup   boolean not null default false,
  note        text
);

create index gym_sets_session_idx on gym_sets (session_id, position);
create index gym_sets_exercise_idx on gym_sets (exercise_id);

alter table exercises              enable row level security;
alter table gym_templates          enable row level security;
alter table gym_template_exercises enable row level security;
alter table gym_sessions           enable row level security;
alter table gym_sets               enable row level security;
