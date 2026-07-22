-- Bodyweight-load correctness for the muscle fatigue model.
--
-- Two fixes that make added weight on a bodyweight-bearing movement read as MORE
-- load than the same movement unloaded (the model consumes weight_kg via
-- app/src/renderer/src/lib/muscleFatigue.ts setLoad):
--
--   1. Add 'tibialis' (shin / tibialis anterior) to the muscle vocabulary. The
--      20-muscle vocab had no dorsiflexor, so shin work (heel walks, resisted
--      dorsiflexion) was stored with EMPTY primary_muscles and deposited zero
--      load regardless of any added weight. Keep this list in sync with
--      muscleFatigue.ts MUSCLES + GROUP_MEMBERSHIP.legs.
--   2. Correct labelling of the exercises that are bodyweight-bearing so the
--      model counts body mass (+ added weight) rather than a flat proxy.

-- CHECK constraints must be dropped and re-added — Postgres can't extend one in
-- place. The new vocab is a strict SUPERSET, so every existing row still passes.
alter table exercises drop constraint exercises_primary_muscles_vocab;
alter table exercises drop constraint exercises_secondary_muscles_vocab;

alter table exercises
  add constraint exercises_primary_muscles_vocab check (
    primary_muscles <@ array['chest','lats','upper back','traps','lower back','front delts','side delts','rear delts','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','tibialis','adductors','abductors','hip flexors','abs','obliques']::text[]
  ),
  add constraint exercises_secondary_muscles_vocab check (
    secondary_muscles <@ array['chest','lats','upper back','traps','lower back','front delts','side delts','rear delts','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','tibialis','adductors','abductors','hip flexors','abs','obliques']::text[]
  );

-- Backfill (idempotent): assign the shin muscle to shin exercises that have no
-- muscle yet. Guarded on empty primary_muscles so a re-run / manual edit is not
-- clobbered.
update exercises
  set primary_muscles = array['tibialis']::text[]
  where lower(name) in ('heel walk', 'resisted band dorsiflexion')
    and coalesce(array_length(primary_muscles, 1), 0) = 0;

-- Standing Calf Raise is performed at bodyweight (you rise on your toes) — the
-- weighted variant is a separate 'Leg Press Calf Raise' row, which stays
-- 'machine'. Re-label so body mass counts as the load. Mirrors the seed change
-- in data/exercise-catalog/legs-core.json.
update exercises
  set equipment = 'bodyweight'
  where lower(name) = 'standing calf raise'
    and equipment = 'machine';
