-- Gym ↔ recovery-plan matching (the TODO #3 integration): a recovery plan
-- item can point at the exercises-catalog entry it corresponds to. When a gym
-- session logs sets of that exercise, the app auto-upserts the day's
-- plan_item_check with source='gym' (the value reserved for this since the
-- injury-tracking migration) — rehab compliance stops needing manual ticks
-- for work that's already logged in the Gym tab.
--
-- The chat agent maintains the linkage via injuries.py (--exercise); items
-- without a link (habits, constraints, non-gym mobility work) are unaffected.

alter table recovery_plan_items
  add column exercise_id uuid references exercises (id) on delete set null;

create index recovery_plan_items_exercise_idx
  on recovery_plan_items (exercise_id) where exercise_id is not null;
