-- Injuries feature (AI-maintained). The chat agent reads via db.py (read-only)
-- and writes via injuries.py (service-role PostgREST). Two tables: the injury
-- record and its dated progress log. RLS enabled with no policies = deny-all
-- for anon/authenticated; the service role bypasses it, matching every other
-- table in this schema.
create table injuries (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,             -- e.g. "Right wrist pain"
  body_area     text,                      -- e.g. "wrist", "lower back"
  status        text not null default 'active' check (status in ('active','recovering','resolved')),
  severity      text check (severity in ('mild','moderate','severe')),
  started_at    date,
  resolved_at   date,
  summary       text,                      -- what it is, mechanism, context
  recovery_plan text,                      -- current plan (markdown ok), AI-maintained
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table injury_notes (
  id         bigint generated always as identity primary key,
  injury_id  uuid not null references injuries (id) on delete cascade,
  noted_at   timestamptz default now(),
  entry_date date not null default current_date, -- the day the note is about
  source     text default 'chat',           -- 'chat' (AI) or 'user'
  note       text not null,
  pain_level smallint check (pain_level between 0 and 10)
);

create index injury_notes_injury_id_idx on injury_notes (injury_id, entry_date desc);

alter table injuries      enable row level security;
alter table injury_notes  enable row level security;
