-- Symptom-gated phase steps.
--
-- `phases` (20260805160000) encoded ramps keyed to calendar weeks only, but
-- the clinically normal taper is a CONDITION, not a date: "drop to 3×/week
-- once two consecutive weeks pass with nothing above 1/10, tested at normal
-- daily activity". Those agreements could only live as prose notes, and the
-- step-down then depended on a human or agent happening to re-read the note
-- on the right day — the failure mode that lost the original taper decision
-- (agent_log 28, then 29).
--
-- A phase step now starts either on a calendar week or on a symptom gate —
-- exactly one of `from_week` / `gate` per step:
--
--   {from_week, weekly_target, green_min, yellow_min}
--   {gate: {kind: 'pain_clear', max_pain, clear_days, note_id?, condition?},
--    applied_on, weekly_target, green_min, yellow_min}
--
-- The gate holds the measurable half of the trigger (entries in injury_notes
-- with pain_level above max_pain restart a clean-day clock; clear_days
-- consecutive clean days satisfy it). The step is only IN FORCE once
-- `applied_on` is stamped — agreed gates carry judgment clauses ("tested at
-- normal walking volume", stored in `condition`) that no query can evaluate,
-- so readers compute and surface the clock but application stays an explicit
-- act (injuries.py plan-advance). Once applied, the step behaves like a
-- calendar phase starting in the week containing applied_on, so past weeks
-- keep grading by the dose in force then. A flare above the gate after
-- application is surfaced as a review flag (the agreed reversion rule).
--
-- jsonb already admits the new shape — this migration only updates the
-- documented contract. Shape is validated in the write paths (chatctx
-- injuries.py + recovery_plan_contract.mjs), which can name the offending
-- field; readers are app lib/injuryStats.ts and injuries.py resolve_targets.
comment on column recovery_plan_items.phases is
  'Ordered later dose steps. Calendar: [{from_week, weekly_target, green_min, '
  'yellow_min}] applies from from_week. Symptom-gated: [{gate: {kind: '
  '''pain_clear'', max_pain, clear_days, note_id?, condition?}, applied_on, '
  'weekly_target, green_min, yellow_min}] applies only once applied_on is '
  'stamped (plan-advance), from the week containing that date. The scalar '
  'columns cover start_week until the first started phase.';
