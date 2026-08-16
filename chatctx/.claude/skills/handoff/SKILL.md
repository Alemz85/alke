---
name: handoff
description: Carry conversational context across chat sessions. Invoked as /handoff to record where things stand at the end of a session, or /handoff read to pick up what the last one left. Use whenever the user refers to an earlier conversation, or a session ends with something unresolved.
---

# Session handoff

Every durable FACT already has a home — `injuries.py` and its notes, `goals.py`, `gym.py`, `agent_log.py`. This skill is for the one thing none of them hold: **the conversation**. What was being worked through, what question is still open, what the user asked to come back to.

Backed by `session_handoffs` via `python3 session.py`:

```
python3 session.py read [--limit N] [--mode analysis|injuries|goals]
python3 session.py write --summary ".." [--open ".."] [--next ".."] [--mode ..]
python3 session.py show <id>
```

## Reading — at the start

Run `session.py read` when the session opens with something that reaches backwards: "where did we get to", "you said last time", "did we ever figure out", a follow-up with no antecedent in this session. Also worth a read before any broad assessment, for the same reason the mode files say to load goals and injuries first — a thread you don't know about is a thread you will make them repeat.

Do not narrate the handoff back at them. It is context for your reply, not the reply. They know what they said last time; what they want is for you to know it too.

## Writing — at the end

Write one when the session actually leaves something behind:

- a question was raised and NOT settled
- you agreed on something to do or check later
- they asked you to remember or return to something
- the session did substantial work on one thread (a plan review, a long diagnostic conversation) that a fresh session would otherwise re-derive

**Don't write one for a session that closed cleanly.** A logged workout, a quick lookup, a question fully answered — nothing is left hanging, and a handoff saying "they asked about their pace, I told them" costs the next session context and buys nothing. An empty handoff is worse than no handoff, because it dilutes the ones that matter.

One handoff per session, written at the end, in prose. The fields:

- `--summary` (required): where things stand. Not a transcript — the state a competent stand-in would need.
- `--open`: the questions left unsettled. **The highest-value field.** This is what would otherwise be silently dropped or re-derived from scratch.
- `--next`: what was agreed to happen next.

## Scope — this is not a second copy of the database

The failure this table can create is duplication: a fact written here as well as in its own table, the two drifting apart, and a later session trusting the wrong one. So:

| the thing | where it goes |
|---|---|
| an agreed rehab taper, progression, or exit criterion | `injuries.py note` — dated, with its symptom trigger (`modes/injuries.md`) |
| a goal settled, changed, paused, abandoned | `goals.py` |
| a tool, schema, or instruction defect you hit | `agent_log.py log` |
| pain, a flare, a milestone, rehab done | `injuries.py` |
| a training session they described | `gym.py log` |
| **what you were discussing and what's still open** | **here** |

If a sentence you are about to write belongs in a row of that table's left column, write it THERE. Reference it from the handoff if it matters to the thread ("picked up the rehab taper — see the note dated today"), but the domain table stays the source of truth, always.

## Why this skill lives here

A handoff skill installed under `~/.claude/skills` will never load in this app: `app/src/main/chatPolicy.ts` spawns the CLI with `--setting-sources project`, so `chatctx/.claude/skills` is the only directory that is read (agent_log #24). Anything added for these sessions belongs in this directory.
