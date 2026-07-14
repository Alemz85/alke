-- Injury notes can describe a time SPAN, not just a single day, and can carry a
-- coarser date precision so an approximate onset ("~2025", "early 2026") is never
-- rendered with false day precision. This lets the course-of-injury timeline
-- (frequency phases, flares, quiet stretches) live in the log where it belongs,
-- keeping injuries.summary a timeless identity of what the injury IS rather than a
-- paragraph that silently goes stale.

alter table injury_notes
  add column entry_end_date date,                    -- inclusive span end; null = single-day note
  add column date_precision text not null default 'day'
    check (date_precision in ('day', 'month', 'year'));

-- entry_date is the START of the period; a span must not run backwards.
alter table injury_notes
  add constraint injury_notes_period_order
  check (entry_end_date is null or entry_end_date >= entry_date);

-- The app's quick log stays a one-row-per-day, highest-pain-wins diary. That
-- rule only ever needed to apply to those user single-day rows, but the old
-- table-wide UNIQUE(injury_id, entry_date) ALSO blocked the chat agent from
-- filing more than one dated/period note per day. Narrow it to a PARTIAL unique
-- index over exactly the mergeable rows (user quick logs), so backdated chat
-- notes and spans can coexist with each other and with a same-day quick log.
alter table injury_notes drop constraint injury_notes_injury_date_unique;
create unique index injury_notes_user_daily_unique
  on injury_notes (injury_id, entry_date)
  where source = 'user' and entry_end_date is null;
