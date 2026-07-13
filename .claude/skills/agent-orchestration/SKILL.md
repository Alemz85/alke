---
name: agent-orchestration
description: Use when spawning subagents or parallel workers in this repo — surface boundaries, dispatch economics, model tiering, and per-surface verification. Read BEFORE dispatching 2+ agents or delegating heavy reading.
---

# Agent orchestration in this repo

Project-specific playbook. Generic dispatch theory lives in `dispatching-parallel-agents` and `subagent-driven-development`; this file is the deltas this codebase has learned.

## Economics — when dispatch actually pays

Subagents do NOT reduce total token spend for a fixed task; they usually increase it (every agent boots fresh: reads CLAUDE.md, explores files). What they buy:

- **Main-context isolation**: heavy reading (payload dumps, logs, screenshots, multi-file exploration) happens in a disposable context and only the distilled answer returns. The main session stays small → prompt cache stays warm, compaction is deferred, long sessions stay coherent. This is the real "token reduction": fewer re-reads and no quality loss from repeated compaction.
- **Wall-clock parallelism**: N independent surfaces built concurrently.
- **Perspective diversity**: review fleets with distinct lenses find bugs a single pass misses.

Dispatch when: (a) ≥2 genuinely independent tasks exist, or (b) the reading required is bulky and one-shot (you need the conclusion, not the material). Work inline when the task is small, single-surface, and you already know where the code is — dispatch overhead exceeds the isolation benefit.

### Launch independent agents at the *start*, not after your own slice

A recurring anti-pattern: the main session does its own piece of the work first and only *then* spawns the agents. If an agent's task doesn't depend on what you're doing right now, that ordering wastes wall-clock — the agent could have been running the entire time you were typing. Before you start a step, ask "what here is independent of it?" and dispatch that immediately, in the *same* turn, so it runs in the background while you work.

Dependence is the **only** valid reason to hold an agent back — it consumes your in-progress output (a frozen contract, a schema, a file you're mid-edit on). "I'll launch them once I finish this part" is not a reason. Concretely: contract-dependent builders wait for the frozen contract; everything else (independent views, read-only exploration, doc/skill edits, unrelated features, a new item the user queues mid-flight) launches on turn one alongside your own work. When a fresh independent task arrives while you're busy, spawn it right then rather than parking it behind your current step — provided its file surface is disjoint (rule 1 still governs).

**Tiering math**: down-tier tokens cost a fraction of top-tier tokens, so the agent's boot tax (re-reading CLAUDE.md, exploring) is paid in cheap tokens while the orchestrator's expensive tokens go only to spec, judgment, and integration. The decision variable is rework probability, not token price: cheap work is only cheap when acceptance is machine-checkable (tests/typecheck gates), because otherwise verification means re-reading the work at top-tier prices — or worse, accepting subtly wrong work and paying during reconciliation. Rule: **delegate down-tier when spec + machine-checkable acceptance costs under ~20% of doing the work; keep in-tier anything whose verification requires re-reading it.** The two mechanisms multiply: expensive-model × small context + cheap-model × large context.

## Non-negotiable rules (learned the hard way — see memory `parallel-agent-file-collisions`)

1. **Strictly disjoint file surfaces.** Every parallel agent gets an explicit, exclusive file list. Never two agents on the same file, even "additively".
2. **Verify a spawn before re-dispatching.** A dispatch that seemed to fail may have launched. Check for its output/completion before sending a duplicate (round 7: two agents built divergent injuries schemas on the same files; reconciliation cost a full round).
3. **Single owner for shared contracts.** `supabase/migrations/` and `app/src/shared/types.ts` are never split across parallel agents. Either one agent owns the contract change, or the main session edits it before/after the fan-out.

## Surface map — natural parallel boundaries

| Surface | Files | Verify with |
|---|---|---|
| Ingest parser | `supabase/functions/ingest/` | `deno test supabase/functions/ingest/` |
| DB schema | `supabase/migrations/` | single owner only, ever |
| Metrics job | `metrics/` | `python3 -m pytest metrics/` |
| Electron main | `app/src/main/` | `npm --prefix app run typecheck` |
| One renderer view | `app/src/renderer/src/views/<View>.tsx` + its `.css` + tests | `npx vitest run` (in `app/`) |
| Chat context | `chatctx/` | round-trip via `db.py` / `injuries.py` |

A "surface" for a parallel agent = one row, or a subset of one row. Cross-row work is sequential or main-session.

## Model tiering (real cost reduction)

- **haiku**: file inventories, mechanical scans, grep-and-report.
- **sonnet**: well-specified implementation against existing patterns — a spec'd view, a parser field, tests-first mechanical work.
- **opus / main-session model**: ambiguous or design-heavy work, cross-cutting changes, review synthesis, anything touching shared contracts.

Default to sonnet for builders when the task is fully specified; reserve the top tier for the spec-writing and the judging, not the typing.

## Return contract

Tell every agent its final message is a distilled report, not a transcript: what changed (files), test evidence (command + pass counts), and surprises/deviations. Never full file dumps. For fan-out research, request structured lists so the main session synthesizes cheaply.

## Patterns proven in this repo

- **Freestyle rounds**: 2–4 builders on disjoint views/surfaces per round, main session integrates + regression-tests + commits.
- **Review fleet**: parallel reviewers with distinct lenses (correctness, security, UX/behavior); the main session **verifies claims before acting** — one "critical" security finding here was empirically disproven before it would have driven an unnecessary rework.
- **Explore-then-act**: read-only Explore agent answers "where/how does X work" so the main context never holds the search.
- **UI verification**: agents launching the app must use `HEALTH_APP_DISPLAY=external` (keeps the user's main monitor free) and screenshot over CDP (port 9333) rather than describing UI from code.
