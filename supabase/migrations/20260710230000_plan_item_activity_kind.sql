-- Distinguish rehab work from cleared/allowed training: new kind 'activity'.
-- Adherence scoring counts only kind='exercise' (rehab) items; activities are
-- tracked but represent "what I'm allowed to do", not recovery work.
alter table recovery_plan_items drop constraint recovery_plan_items_kind_check;
alter table recovery_plan_items
  add constraint recovery_plan_items_kind_check
  check (kind in ('exercise','habit','constraint','activity'));
