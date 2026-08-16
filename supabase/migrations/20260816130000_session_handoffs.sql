-- Cross-session continuity for the in-app chat.
--
-- Every durable FACT the chat agent learns already has a home: injuries and
-- their notes, goals, gym sessions, the agent log. What had no home was the
-- conversation itself — what was being worked through, what question was left
-- hanging, what the user asked to come back to. That evaporated at the end of
-- every session (agent_log #24).
--
-- The user had installed a third-party handoff skill under ~/.claude/skills to
-- solve this. It could never have loaded: app/src/main/chatPolicy.ts spawns the
-- CLI with `--setting-sources project`, so only chatctx/.claude/skills is
-- visible. Hence a first-party skill in that directory, backed by this table.
--
-- SCOPE DISCIPLINE — this table is for conversational thread, NOT domain facts.
-- An agreed rehab taper belongs in injury_notes (agent_log #28), a goal change
-- in goals, a tooling defect in agent_log. Anything written here that belongs
-- in one of those tables is a duplicate that will silently drift out of date,
-- and the domain table is always the one a later session should trust.
--
-- Same access model as gym/injuries/goals: RLS deny-all, service role bypasses.
create table if not exists session_handoffs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  -- Which role the session was in ('analysis' | 'injuries' | 'goals'), so a
  -- later session can weight a handoff from its own mode more heavily.
  -- Unconstrained text: modes are a chatctx convention, not a DB contract, and
  -- a CHECK here would need a migration every time one is added.
  mode        text,
  -- Where things stand at the end of the session, in prose. Required — a
  -- handoff with no state is noise in the next session's context window.
  summary     text not null,
  -- Questions raised and NOT settled. The single highest-value field: this is
  -- what a fresh session would otherwise re-derive or, worse, silently drop.
  open_threads text,
  -- What was agreed to happen next. Anything with a symptom trigger attached to
  -- an injury goes to injury_notes as well — see the scope note above.
  next_steps  text
);

-- The read path is almost always "the most recent handoff(s)".
create index session_handoffs_created_at_idx on session_handoffs (created_at desc);

alter table session_handoffs enable row level security;
