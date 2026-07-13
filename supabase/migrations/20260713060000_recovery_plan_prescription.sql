alter table public.recovery_plan_items
  add column if not exists target_sets smallint,
  add column if not exists target_reps smallint;

alter table public.recovery_plan_items
  add constraint recovery_plan_items_target_sets_check
    check (target_sets is null or target_sets between 1 and 20),
  add constraint recovery_plan_items_target_reps_check
    check (target_reps is null or target_reps between 1 and 100);

comment on column public.recovery_plan_items.target_sets is
  'Prescribed working-set count when this item is loadable into a Gym log.';
comment on column public.recovery_plan_items.target_reps is
  'Prescribed reps per working set when this item is loadable into a Gym log.';
