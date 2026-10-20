# Alke: instructions for coding sessions

> In-app chat agent (working directory `chatctx/`): this file is for development sessions,
> not for you. Ignore it; your instructions are `chatctx/CLAUDE.md`.

## Layout
| Path | What |
| --- | --- |
| `supabase/` | SQL migrations; `ingest` and `gymcard` Edge Functions (Deno/TypeScript) |
| `metrics/` | Nightly metrics job (Python 3.12) |
| `app/` | Electron + React + Vite desktop app |
| `chatctx/` | Working directory of the in-app chat agent: helpers, instructions, modes |
| `gymcard-web/` | Vercel port of the phone gym card |
| `scripts/` | One-off importers, backfills, the leak gate |
| `private/` | The owner's private root: its own git repo, gitignored here (see below) |

## Checks
- `python -m pytest metrics/tests` and `python -m pytest chatctx/tests scripts/leakgate`
- `node --test chatctx/tests/*.mjs`
- `deno test` in `supabase/functions/ingest` and `supabase/functions/gymcard`
- in `app/`: `npm run typecheck`, `npm test`, `npm run lint`

## Personal data: where it goes
This repo is public. The owner's data lives in the database and in `private/`, never here.
- **Anything about the owner goes in `private/`**: notes, TODOs, plans and specs, chat
  context written about them, health documents, exports, backups, caches. That is the
  default for every new personal file; there is no other place to decide between.
- **Personal docs stay personal.** Don't rewrite them into generic text. The repo ships
  generic defaults and the private root overrides or extends them (next section).
- Never commit anything under `private/`, never add `!` re-includes for it, and never copy
  private text, real values, real dates or real places into code, tests, comments, docs or
  commit messages. Test fixtures use invented data.
- **A blocked push means: fix the leak** (amend or rebase the commit) and push again.
  Never bypass the leak gate with `--no-verify`.

## Overrides: private first, repo default second
| Private file | Effect |
| --- | --- |
| `private/CLAUDE.md` | your notes for coding sessions (imported via the gitignored `CLAUDE.local.md`) |
| `private/chatctx/CLAUDE.md` | appended to the chat agent's `chatctx/CLAUDE.md` |
| `private/chatctx/modes/<m>.md` | replaces `chatctx/modes/<m>.md` |
| `private/chatctx/modes/<m>.add.md` | appended after `chatctx/modes/<m>.md` |
| `private/chatctx/.claude/skills/<name>/` | an extra chat skill (new names only) |

The chat agent reads its instructions through `python3 chatctx/ctx.py mode <m>`, which
applies these rules. The desktop app points it at the private root with `ALKE_PRIVATE_ROOT`.

## Setup on the owner's machine
- `npm run setup`: installs the leak gate (`git config core.hooksPath .githooks`) and
  writes `CLAUDE.local.md`.
- `npm run backup`: commits and pushes `private/` and `private/knowledge` to their
  private remotes.
- `npm run leakgate:refresh`: rebuilds the gate's private term cache (needs the DB).
