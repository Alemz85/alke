# Personal Health Analytics Platform

A single-user analytics platform for my own Apple Watch / Apple Health data — training
load, recovery, and aerobic-base (Zone 2) trends, with an AI chat that reasons over the
numbers. Built as a personal project: the whole stack runs against one private database,
and no data is collected from anyone but the owner.

Three independent programs share one Supabase Postgres database:

1. **Ingestion Edge Function** (Deno/TypeScript) — the
   [Health Auto Export](https://github.com/Lybron/health-auto-export) iOS app POSTs new
   health data to it; a pure, unit-tested parser normalizes each payload. Idempotent under
   re-delivery (workouts upsert, samples dedupe, daily metrics merge per column).
2. **Nightly metrics job** (Python, GitHub Actions cron at 03:30 UTC) — computes
   training-load (CTL / ATL / TSB / ACWR), recovery, and Zone-2 aerobic-base metrics from
   the raw data, plus correlational insights.
3. **Electron desktop app** (React + Vite) — renders the dashboard and embeds an AI chat
   driven by the local Claude Code CLI. Offline-first, with an optimistic write queue.

All UI follows the design system in [`DESIGN.md`](DESIGN.md).

## Highlights

- **Sports-science modeling** grounded in endurance-training literature — detraining
  kinetics, maintenance dose, efficiency (EF) / decoupling trends, and a two-compartment
  Zone-2 fitness model (a slow-moving durable base vs. a fast-moving form layer). Every
  load-bearing constant is a documented literature prior that personalizes as history
  grows; see [`docs/muscle-fatigue-model.md`](docs/muscle-fatigue-model.md) for one model's
  full spec.
- **Informational, not medical** — every estimate is banded with its uncertainty shown,
  never presented as a diagnosis or clinical advice.
- **AI chat over your own data** — the desktop app spawns the local Claude Code CLI in
  `chatctx/`, which reads the database (read-only SQL) and a curated training-science
  knowledge base to answer questions and log injuries and goals.

## Layout

| Path | Component |
| --- | --- |
| `/supabase` | SQL migrations + `ingest` Edge Function (Deno/TypeScript) |
| `/metrics`  | Nightly metrics job (Python 3.12) |
| `/.github`  | Actions workflow running the metrics job at 03:30 UTC |
| `/app`      | Electron + React + Vite desktop app |
| `/chatctx`  | Working directory given to the Claude Code chat sessions |

## Running each component

**Ingestion** — deployed to Supabase: `supabase functions deploy ingest`. Local tests:
`deno test supabase/functions/ingest/` (no network needed). The Health Auto Export payload
format the endpoint parses is documented under `docs/vendor/hae-wiki/`.

**Metrics job** — `pip install -r metrics/requirements.txt && python -m metrics.compute`
with `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` in the environment (`--full` recomputes all
history). Runs nightly via GitHub Actions. Tests: `python -m pytest metrics/`.

**Desktop app (dev)** — `cd app && npm install && npm run dev`. Needs `app/.env` with the
Supabase credentials (see `app/.env.example`). Checks: `npm run typecheck` and
`npx vitest run`.

**Desktop app (packaged macOS build)** — `cd app && npm run dist:mac`. Builds the
renderer/main bundles with `electron-vite` and packages a `.dmg` and `.zip` with
`electron-builder` into `app/release/` (gitignored). The build is unsigned
(`identity: null`, no Apple Developer account) — on first launch of a copy that carries the
Gatekeeper quarantine flag, macOS refuses to open it with a normal double-click; **right-click
the app → Open → Open** once to bypass Gatekeeper, or run `xattr -cr "Health Analytics.app"`
before launching.

**Packaged build credentials** — in dev the main process loads `app/.env` (resolved
relative to `__dirname`). That path doesn't exist in a packaged app, so the packaged build
instead reads `.env` from its userData directory (`~/Library/Application
Support/health-analytics-app/.env` on macOS), using the same keys as `app/.env.example`.
Secrets are never bundled into the app itself.

## Configuration & secrets

Copy `.env.example` to `.env` in each component that needs it and fill in the values; real
`.env` files are gitignored everywhere and no keys are ever committed. `supabase/config.toml`
ships with a placeholder `project_id` — set your own, or pass `--project-ref` on deploy.
