-- Timed doses in gym templates.
--
-- gym_template_exercises could only express a rep-counted dose, so a
-- prescribed hold ("wall sit, 3 × 45 seconds") had nowhere honest to
-- go: it shipped as "3 sets × 1 rep" with the real duration buried in a note,
-- which reads as a single rep to every consumer (card, view modal, duration
-- estimate, log prefill). recovery_plan_items already solved this with
-- structured `steps` carrying duration_seconds; templates get the same measure
-- as a first-class column.
--
-- One dose measure per row, mirroring the recovery-plan step contract: an
-- exercise is either rep-counted or time-counted, never both. Existing rows are
-- all rep-counted and stay valid (target_duration_seconds defaults to null).
alter table gym_template_exercises
  add column target_duration_seconds smallint
    check (target_duration_seconds between 1 and 3600);

alter table gym_template_exercises
  add constraint gym_template_exercises_single_dose_measure check (
    target_reps is null or target_duration_seconds is null
  );
