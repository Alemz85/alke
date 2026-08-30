-- Manual indoor-cardio EF inputs (agent_log 34 + 35, phase 1).
--
-- WHY. Indoor cardio buys training load but no EVIDENCE: every indoor_cycling
-- and rowing session has distance_m NULL, so ef() returns NULL and the Zone-2
-- level fusion never sees them. A single short OUTDOOR ride was
-- enough to wake the bike_ef channel and collapse the model's confidence band
-- (0.46/width-42 -> 0.79/width-17), which is the measure of what the EF channel
-- is worth — and today only outdoor work can reach it.
--
-- The fix is per-modality, because the honest EF input differs by machine:
--   * indoor bike  -> AVERAGE WATTS. The machine's "distance" is fabricated
--                     from an uncalibrated wheel/flywheel model and is not
--                     comparable between machines or even between resistance
--                     settings. Power is machine-independent and is the true
--                     cycling EF input (W per beat).
--   * rower        -> DISTANCE. Concept2-class ergs are factory-calibrated, so
--                     distance/time IS meaningful; a plain metres field works.
--   * treadmill    -> DISTANCE + INCLINE. Apple's indoor-run distance comes from
--                     an accelerometer model calibrated by OUTDOOR GPS runs, and
--                     a user may have none, so the device figure is not
--                     trusted for EF. A manually entered distance SUPERSEDES it.
--                     Grade is not optional: speed per beat at 6% incline is a
--                     different quantity from speed per beat on the flat, so
--                     treadmill EF is computed only for runs whose incline was
--                     explicitly logged AND near-flat (metrics/models.py,
--                     TREADMILL_FLAT_INCLINE_PCT_MAX).
--
-- Phase 2 (a calibration model that CORRECTS device distance, or an incline-
-- adjusted grade-equivalent pace) is deliberately NOT built here.

-- ---------------------------------------------------------------------------
-- workouts: owner-entered inputs. All nullable, all NULL by default; NULL means
-- "not logged", never "zero". Nothing in the ingest path writes these columns
-- (see supabase/functions/ingest/) so a Health Auto Export re-delivery or an
-- Apple Health workout REPLACEMENT can never overwrite them.
-- ---------------------------------------------------------------------------
alter table workouts
  -- Average mechanical power in WATTS over the session, read off the machine's
  -- console. Feeds power EF = watts / avg_hr (W per beat) — a DIFFERENT UNIT
  -- from the speed EF stored in computed_workout.ef (m/min per beat); the two
  -- never share a column, a baseline, or a comparison.
  add column if not exists manual_avg_watts numeric
    check (manual_avg_watts > 0 and manual_avg_watts < 2000),
  -- True session distance in METRES, entered by the owner. Supersedes
  -- workouts.distance_m for EF wherever the device figure is untrusted
  -- (treadmill) or absent (erg). Not a correction OF distance_m — that column
  -- stays exactly as ingested, so the raw device reading is never lost.
  add column if not exists manual_distance_m numeric
    check (manual_distance_m > 0 and manual_distance_m < 1000000),
  -- Treadmill grade in PERCENT (rise/run x 100, so 1.5 means 1.5%, not 0.015).
  -- NULL = not logged, which is NOT the same as 0: an unlogged incline withholds
  -- treadmill EF entirely rather than assuming flat. Negative values (declines)
  -- are allowed and are equally disqualifying for a flat-run EF.
  add column if not exists manual_incline_pct numeric
    check (manual_incline_pct >= -30 and manual_incline_pct <= 40);

comment on column workouts.manual_avg_watts is
  'Owner-entered average power (W) for an indoor bike session; machine-independent EF input (power EF = W/bpm). NULL = not logged. Never written by ingest.';
comment on column workouts.manual_distance_m is
  'Owner-entered true distance (m). SUPERSEDES distance_m for EF (treadmill accelerometer distance is untrusted here; ergs report no distance at all). NULL = not logged. Never written by ingest.';
comment on column workouts.manual_incline_pct is
  'Treadmill grade in percent (rise/run x 100). NULL = not logged, which withholds treadmill EF rather than assuming flat.';

-- ---------------------------------------------------------------------------
-- computed_workout: power EF gets its OWN column. This is the unit separation
-- enforced at the schema level — `ef` is metres-per-minute per beat, `power_ef`
-- is watts per beat. Storing watts EF in `ef` would silently poison the bike_ef
-- observation series (compute.py collects any cycling workout with a non-null
-- ef), so the schema makes that mistake impossible rather than relying on a
-- comment.
-- ---------------------------------------------------------------------------
alter table computed_workout
  add column if not exists power_ef numeric;

comment on column computed_workout.power_ef is
  'Cycling power efficiency factor in WATTS PER BEAT (manual_avg_watts / avg_hr), gated by the same steady-aerobic eligibility as ef. NEVER comparable to computed_workout.ef (m/min per beat).';

-- ---------------------------------------------------------------------------
-- zone2_fitness_params: one owner-ratified detrained baseline per NEW EF
-- channel, exactly as 20260826123000 did for run_ef/bike_ef. NULL (the default,
-- and the state this migration leaves them in) = the signal is collected,
-- stored and displayed but WITHHELD from the level fusion — so shipping these
-- channels changes no model number until the owner ratifies a baseline.
--
-- Each channel is separate because its baseline is not interchangeable with any
-- other's:
--   bike_power_ef_baseline  W/bpm      — different UNIT from bike_ef.
--   row_ef_baseline         m/min/bpm  — same unit as run EF, different sport
--                                        (a rowing stroke's economy says nothing
--                                        about running economy).
--   treadmill_ef_baseline   m/min/bpm  — same unit AND same sport as run_ef, but
--                                        a belt with no air resistance is a
--                                        systematically different economy, so it
--                                        must not be scored against the outdoor
--                                        run baseline.
-- ---------------------------------------------------------------------------
alter table zone2_fitness_params
  add column if not exists bike_power_ef_baseline numeric,
  add column if not exists row_ef_baseline numeric,
  add column if not exists treadmill_ef_baseline numeric;

comment on column zone2_fitness_params.bike_power_ef_baseline is
  'Owner-ratified detrained baseline for the cycling POWER EF channel (W/bpm). NULL = unratified: collected and displayed, withheld from the Zone-2 level fusion.';
comment on column zone2_fitness_params.row_ef_baseline is
  'Owner-ratified detrained baseline for the rowing speed-EF channel (m/min per bpm). NULL = unratified (withheld from the level fusion).';
comment on column zone2_fitness_params.treadmill_ef_baseline is
  'Owner-ratified detrained baseline for the treadmill speed-EF channel (m/min per bpm), kept separate from run_ef_baseline because belt running is a different economy. NULL = unratified (withheld from the level fusion).';
