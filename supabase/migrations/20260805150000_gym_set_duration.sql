-- Timed doses in LOGGED sets — the other half of 20260805120000, which gave
-- gym templates a target_duration_seconds.
--
-- gym_sets recorded reps only, so a 60-second wall sit and a 1-second twitch
-- both stored as `reps: 1`: the prescription could be written honestly on the
-- template while the performance still had to be falsified to log it. Anything
-- totalling work by joining gym_sets → exercises mis-counted holds the same way.
--
-- One dose measure per set, matching the template rule: a set is either
-- rep-counted or time-counted. Existing rows are all rep-counted and stay
-- valid (duration_s defaults to null). Sets with NEITHER remain legal — a
-- set-less/blank row is an existing granularity tier, not a violation.
alter table gym_sets
  add column duration_s smallint check (duration_s between 1 and 3600);

alter table gym_sets
  add constraint gym_sets_single_dose_measure check (
    reps is null or duration_s is null
  );
