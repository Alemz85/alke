alter table public.injuries
  add column if not exists plan_started_at date;

comment on column public.injuries.plan_started_at is
  'Start date of the current structured recovery plan; distinct from injury onset.';

alter table public.recovery_plan_items
  add column if not exists start_week smallint not null default 1;

alter table public.recovery_plan_items
  add constraint recovery_plan_items_start_week_check
    check (start_week between 1 and 52);

comment on column public.recovery_plan_items.start_week is
  'Cumulative plan week when this item first becomes adherence-accountable.';
