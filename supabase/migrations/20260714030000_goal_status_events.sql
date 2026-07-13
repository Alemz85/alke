-- Goal status timeline. Every status transition appends a timestamped row so
-- the chat agent has full context on how long a goal ran and when it paused /
-- resumed / ended. The denormalized goals.status_changed_at powers the card's
-- "active for X since <date>" line without a join.
alter table goals
  add column status_changed_at timestamptz not null default now();

update goals set status_changed_at = coalesce(updated_at, started_at::timestamptz, now());

create table goal_status_events (
  id         bigint generated always as identity primary key,
  goal_id    uuid not null references goals (id) on delete cascade,
  status     text not null check (status in ('active', 'on_hold', 'completed', 'abandoned')),
  changed_at timestamptz not null default now(),
  source     text not null default 'user' check (source in ('user', 'chat'))
);

create index goal_status_events_goal_idx on goal_status_events (goal_id, changed_at);

-- Seed one event per existing goal so the timeline is populated for history.
insert into goal_status_events (goal_id, status, changed_at, source)
select id, status, coalesce(updated_at, started_at::timestamptz, now()), created_by
from goals;

alter table goal_status_events enable row level security;
