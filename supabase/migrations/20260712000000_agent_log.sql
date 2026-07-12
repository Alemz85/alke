-- Agent issue log: the chat agent self-reports problems it hits in
-- production sessions — wrong schema assumptions, failing tools, suspicious
-- data, weak knowledge entries — so those observations stop dying with the
-- session. Consumed two ways: dev sessions review unresolved entries when
-- starting maintenance work, and repeated flags on the same subject mark
-- bad knowledge/docs for re-curation (TODO #2; knowledge library is TODO #1).
--
-- Same access model as injuries/goals: RLS deny-all, service role bypasses;
-- writes go through the narrowly-scoped chatctx/agent_log.py helper.

create table agent_log (
  id           bigint generated always as identity primary key,
  logged_at    timestamptz not null default now(),
  category     text not null check (category in ('knowledge', 'schema', 'tool', 'data', 'instructions', 'other')),
  severity     text not null check (severity in ('info', 'issue', 'blocker')),
  -- The join key for counting repeats: a knowledge-library file path, a
  -- table/column name, a tool/helper name — one canonical string per thing.
  subject      text not null,
  detail       text not null,
  session_hint text,        -- optional free-form pointer to the originating session/context
  resolved_at  timestamptz  -- null = open; set by dev sessions once the cause is fixed
);

create index agent_log_category_subject_idx on agent_log (category, subject);

alter table agent_log enable row level security;
