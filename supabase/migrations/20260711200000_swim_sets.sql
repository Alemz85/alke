-- Swim set analytics (docs/superpowers/specs/2026-07-11-swim-set-analytics-design.md).
-- Per-second swim series parsed by the ingest function from HAE swimDistance/
-- swimStroke arrays, plus the sets derived from them. Both are replaced
-- wholesale per workout on re-delivery (re-derivation may shift boundaries).

create table workout_swim_samples (
  workout_id uuid not null references workouts (id) on delete cascade,
  offset_s   int not null,
  distance_m numeric not null,
  strokes    numeric not null,
  primary key (workout_id, offset_s)
);

create table swim_sets (
  workout_id     uuid not null references workouts (id) on delete cascade,
  set_index      int not null,
  start_offset_s int not null,
  duration_s     int not null,
  distance_m     numeric not null,
  strokes        numeric not null,
  rest_after_s   int,
  primary key (workout_id, set_index)
);

alter table workout_swim_samples enable row level security;
alter table swim_sets            enable row level security;
