-- Frequency that ramps by plan week.
--
-- A recovery_plan_items row held ONE weekly_target (plus one green_min /
-- yellow_min pair), so a prescription whose FREQUENCY changes over time had no
-- honest encoding. start_week only says when an item becomes accountable, not
-- what its dose is from then on.
--
-- A typical case: a clinician prescribes two exercises at 3×/week in week 1,
-- then DAILY from week 2. Every option was bad — one row at 7 scores RED for
-- correctly following the week-1 prescription (a false efficacy claim, which
-- the weekly-target rulebook explicitly forbids); one row at 3 understates
-- every week after the first; and the workaround actually used — a second row
-- per exercise ('… — week 1' and '… — daily') — leaves BOTH rows active and
-- accountable in week 2+, double-counts one exercise against two targets, and
-- auto-checks both from a single gym log because they share an exercise_id.
--
-- `phases` is an ordered list of LATER steps: [{from_week, weekly_target,
-- green_min, yellow_min}, …]. The scalar columns keep their present meaning —
-- the dose from `start_week` onward — and a phase overrides them from its
-- `from_week` on. An item with no phases therefore behaves exactly as before,
-- which is why this needs no backfill.
--
-- Shape is validated in the write paths (app/src/main/db.ts, chatctx
-- injuries.py + recovery_plan_contract.mjs) where a violation can name the
-- offending field; the constraint here just keeps the column an array.
alter table recovery_plan_items
  add column phases jsonb;

alter table recovery_plan_items
  add constraint recovery_plan_items_phases_is_array check (
    phases is null or jsonb_typeof(phases) = 'array'
  );

comment on column recovery_plan_items.phases is
  'Ordered later dose steps: [{from_week, weekly_target, green_min, yellow_min}]. '
  'Applies from from_week; the scalar columns cover start_week until the first phase.';
