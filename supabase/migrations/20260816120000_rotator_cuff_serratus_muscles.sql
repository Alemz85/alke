-- Rotator cuff and serratus anterior enter the muscle vocabulary.
--
-- The 21-value vocab had no entry for either, so when the catalog's empty
-- primary_muscles were filled, six cuff/scapular movements
-- were forced onto the nearest listed muscle (agent_log #22):
--
--   Band/Cable External Rotation -> 'rear delts'   (really infraspinatus + teres minor)
--   Band Internal Rotation       -> 'front delts'  (really subscapularis)
--   Supine Floor / Wall / Prone Overhead Arm Slide -> 'traps' alone
--                                                  (really lower trap + serratus anterior)
--
-- CONSEQUENCE this fixes: the muscle/volume analytics join gym_sets ->
-- exercises, so every rear-delt and front-delt figure was inflated by cuff/scapular
-- rehab work that is not delt training — and such work is typically high-frequency
-- and light, so it can be a large share of those sets.
-- Because the labels live on the exercises row rather than on each set,
-- re-pointing the six rows corrects all history retroactively.
--
-- Keep this vocabulary in sync with muscleFatigue.ts MUSCLES (+ GROUP_MEMBERSHIP,
-- MUSCLE_ISO_JOINT, muscleSizeFactor), chatctx/gym.py MUSCLES,
-- chatctx/workout_template_contract.mjs, and scripts/seed_exercises.ts.

-- CHECK constraints must be dropped and re-added — Postgres can't extend one in
-- place. The new vocab is a strict SUPERSET, so every existing row still passes.
alter table exercises drop constraint exercises_primary_muscles_vocab;
alter table exercises drop constraint exercises_secondary_muscles_vocab;

alter table exercises
  add constraint exercises_primary_muscles_vocab check (
    primary_muscles <@ array['chest','lats','upper back','traps','lower back','front delts','side delts','rear delts','rotator cuff','serratus','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','tibialis','adductors','abductors','hip flexors','abs','obliques']::text[]
  ),
  add constraint exercises_secondary_muscles_vocab check (
    secondary_muscles <@ array['chest','lats','upper back','traps','lower back','front delts','side delts','rear delts','rotator cuff','serratus','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','tibialis','adductors','abductors','hip flexors','abs','obliques']::text[]
  );

-- Re-point the six mislabelled rows. Each update is guarded on the exact wrong
-- value it is correcting, so a re-run (or a later manual edit) is not clobbered.

-- External rotation: the cuff's external rotators are the prime movers. The
-- posterior deltoid genuinely assists, so it moves to SECONDARY rather than
-- being dropped — the error was calling it the prime mover, not naming it.
update exercises
  set primary_muscles = array['rotator cuff']::text[],
      secondary_muscles = array['rear delts','traps']::text[]
  where lower(name) in ('band external rotation', 'cable external rotation')
    and primary_muscles = array['rear delts']::text[];

-- Internal rotation: subscapularis is the prime mover. Lats and chest are
-- powerful internal rotators too and were already correctly secondary.
update exercises
  set primary_muscles = array['rotator cuff']::text[],
      secondary_muscles = array['lats','chest']::text[]
  where lower(name) = 'band internal rotation'
    and primary_muscles = array['front delts']::text[];

-- Scapular slides: 'traps' was not wrong (lower trapezius is the other half of
-- the upward-rotation force couple, and the vocab has no upper/lower split), it
-- was incomplete. Serratus anterior joins it as a co-primary.
update exercises
  set primary_muscles = array['serratus','traps']::text[]
  where lower(name) in ('supine floor slide', 'wall slide', 'prone overhead arm slide')
    and primary_muscles = array['traps']::text[];
