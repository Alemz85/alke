alter table public.recovery_plan_items
  add column if not exists steps jsonb;

alter table public.recovery_plan_items
  add constraint recovery_plan_items_steps_array_check
    check (steps is null or jsonb_typeof(steps) = 'array');

comment on column public.recovery_plan_items.steps is
  'Structured sub-steps for composite off-catalog routines: name plus sets, reps, duration, or distance.';
