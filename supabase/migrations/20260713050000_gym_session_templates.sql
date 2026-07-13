-- A logged gym session can draw from several templates: for example a rehab
-- block, a core block, and an upper-body session. Keep the original
-- gym_sessions.template_id as the legacy/primary template while this table is
-- the canonical many-to-many record used for usage counts and the editor.
create table gym_session_templates (
  session_id  uuid not null references gym_sessions (id) on delete cascade,
  template_id uuid not null references gym_templates (id) on delete restrict,
  position    smallint not null default 0 check (position between 0 and 49),
  created_at  timestamptz not null default now(),
  primary key (session_id, template_id)
);

create index gym_session_templates_template_idx
  on gym_session_templates (template_id, session_id);

-- Retain all historical single-template usage when the join table lands.
insert into gym_session_templates (session_id, template_id, position)
select id, template_id, 0
from gym_sessions
where template_id is not null
on conflict do nothing;

alter table gym_session_templates enable row level security;
