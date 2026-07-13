-- Workout template versioning + run history.
--
-- Versioning: a template can be superseded by a new version (a small upgrade or
-- diff). Every version of a template shares a family_id and is navigable via a
-- version dropdown in the UI; is_current marks the version the app logs against.
-- Each existing template becomes its own family at version 1.
alter table gym_templates
  add column family_id  uuid,
  add column version    smallint not null default 1 check (version >= 1),
  add column is_current boolean not null default true;

update gym_templates set family_id = id where family_id is null;

alter table gym_templates alter column family_id set not null;

create index gym_templates_family_idx on gym_templates (family_id, version);

-- Run history: putting a template into use opens a run (ended_at null); "mark
-- complete" — or the coach archiving an active plan to design a new one — closes
-- it; resurrecting opens a fresh run. A template family accumulates many
-- start/end entries over its lifetime.
create table gym_template_runs (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references gym_templates (id) on delete cascade,
  started_at  date not null default current_date,
  ended_at    date,
  source      text not null default 'user' check (source in ('user', 'chat')),
  created_at  timestamptz default now(),
  check (ended_at is null or ended_at >= started_at)
);

create index gym_template_runs_template_idx on gym_template_runs (template_id, started_at desc);

-- At most one open (active) run per template version.
create unique index gym_template_runs_one_open_idx
  on gym_template_runs (template_id) where ended_at is null;

alter table gym_template_runs enable row level security;
