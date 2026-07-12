-- Gym round 2: structured exercise-catalog metadata for smart autocomplete +
-- analytics, and body-parts-only quick logging (the laziest granularity tier).
--
-- The exercises table becomes a curated catalog (seeded from
-- data/exercise-catalog/ via scripts/seed_exercises.ts, upsert on name_key —
-- re-runnable as the catalog grows) that still accepts user-created rows via
-- create-on-type (source='user', name + optional body_part only).

-- muscle_group was a v1 placeholder no UI ever wrote (table was empty at this
-- migration's ship date); superseded by the structured columns below.
alter table exercises drop column muscle_group;

alter table exercises
  add column aliases           text[] not null default '{}', -- lowercase alternate names: abbreviations ("rdl"), Italian gym terms ("stacco rumeno")
  add column body_part         text check (body_part in ('chest','back','shoulders','arms','legs','core','full body')),
  add column primary_muscles   text[] not null default '{}',
  add column secondary_muscles text[] not null default '{}',
  add column equipment         text check (equipment in ('barbell','dumbbell','kettlebell','machine','cable','bodyweight','band','smith machine','ez bar','trap bar','other')),
  add column mechanics         text check (mechanics in ('compound','isolation')),
  add column movement_pattern  text check (movement_pattern in ('squat','hinge','lunge','horizontal push','vertical push','horizontal pull','vertical pull','carry','core','rotation','isolation')),
  add column source            text not null default 'user' check (source in ('catalog','user'));

alter table exercises
  add constraint exercises_primary_muscles_vocab check (
    primary_muscles <@ array['chest','lats','upper back','traps','lower back','front delts','side delts','rear delts','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','adductors','abductors','hip flexors','abs','obliques']::text[]
  ),
  add constraint exercises_secondary_muscles_vocab check (
    secondary_muscles <@ array['chest','lats','upper back','traps','lower back','front delts','side delts','rear delts','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','adductors','abductors','hip flexors','abs','obliques']::text[]
  );

-- Body-parts-only quick log: user-declared list for set-less sessions.
-- Display rule (renderer-owned): when a session HAS sets, body parts derive
-- from the sets' exercises; this column is the fallback for the lazy tier.
alter table gym_sessions
  add column body_parts text[] check (
    body_parts <@ array['chest','back','shoulders','arms','legs','core','full body']::text[]
  );
