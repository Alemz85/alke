# Personal Health Analytics Platform

Private, single-user analytics for Apple Watch / Apple Health data. Three independent programs share one Supabase Postgres database: (1) an **ingestion Edge Function** that the Health Auto Export iOS app POSTs new health data to, (2) a **nightly metrics job** (Python, GitHub Actions cron) that computes training-load and recovery metrics from the raw data, and (3) an **Electron desktop app** that renders the dashboard and embeds an AI chat driven by the local Claude Code CLI. Full build spec in `SPEC.md`; all UI follows `DESIGN.md`.

## Layout

| Path | Component |
| --- | --- |
| `/supabase` | SQL migrations + `ingest` Edge Function (Deno/TypeScript) |
| `/metrics` | Nightly metrics job (Python 3.12) |
| `/.github` | Actions workflow running the metrics job at 03:30 UTC |
| `/app` | Electron + React + Vite desktop app |
| `/chatctx` | Working directory given to Claude Code chat sessions |

## Running each component

**Ingestion** — deployed to Supabase: `supabase functions deploy ingest`. Local tests: `deno test supabase/functions/ingest/`. Endpoint setup for the iOS app is in `SETUP.md`.

**Metrics job** — `pip install -r metrics/requirements.txt && python -m metrics.compute` with `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` in the environment (`--full` recomputes all history). Runs nightly via GitHub Actions.

**Desktop app** — `cd app && npm install && npm run dev`. Needs `app/.env` with the Supabase credentials (see `.env.example`).

## Secrets

Copy `.env.example` to `.env` and fill in values; real `.env` files are gitignored everywhere. Never commit keys.
