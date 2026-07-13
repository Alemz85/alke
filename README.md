# Personal Health Analytics Platform

Private, single-user analytics for Apple Watch / Apple Health data. Three independent programs share one Supabase Postgres database: (1) an **ingestion Edge Function** that the Health Auto Export iOS app POSTs new health data to, (2) a **nightly metrics job** (Python, GitHub Actions cron) that computes training-load and recovery metrics from the raw data, and (3) an **Electron desktop app** that renders the dashboard and embeds an AI chat driven by the local Claude Code CLI. All UI follows `DESIGN.md`.

## Purpose & scope

A personal fitness self-tracking tool for **one user's own** Apple Health data — training
load, recovery, and aerobic-base (Zone 2) trends computed from workouts, heart rate, HRV,
sleep, and VO₂max the user already records on their own Apple Watch. It is **informational,
not medical**: the numbers are training-analytics estimates (banded, with their
uncertainty shown), not diagnoses or clinical advice. There is no third-party data, no
data collection from anyone but the owner, and nothing is shared externally — the database,
the desktop app, and the AI chat all run against the single owner's private credentials.
The sports-science modeling (detraining kinetics, maintenance dose, efficiency trends)
is standard endurance-training literature applied to the owner's own numbers.

## Layout

| Path | Component |
| --- | --- |
| `/supabase` | SQL migrations + `ingest` Edge Function (Deno/TypeScript) |
| `/metrics` | Nightly metrics job (Python 3.12) |
| `/.github` | Actions workflow running the metrics job at 03:30 UTC |
| `/app` | Electron + React + Vite desktop app |
| `/chatctx` | Working directory given to Claude Code chat sessions |

## Running each component

**Ingestion** — deployed to Supabase: `supabase functions deploy ingest`. Local tests: `deno test supabase/functions/ingest/`. The Health Auto Export payload format the endpoint parses is documented under `docs/vendor/hae-wiki/`.

**Metrics job** — `pip install -r metrics/requirements.txt && python -m metrics.compute` with `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` in the environment (`--full` recomputes all history). Runs nightly via GitHub Actions.

**Desktop app (dev)** — `cd app && npm install && npm run dev`. Needs `app/.env` with the Supabase credentials (see `.env.example`).

**Desktop app (packaged macOS build)** — `cd app && npm run dist:mac`. Builds the renderer/main bundles with `electron-vite` and packages a `.dmg` and `.zip` with `electron-builder` into `app/release/` (gitignored, not committed). The build is unsigned (`identity: null`, no Apple Developer account involved) — on first launch of a copy that has been downloaded or transferred (i.e. carries the Gatekeeper quarantine flag), macOS will refuse to open it with a normal double-click; **right-click the app → Open → Open** once to bypass Gatekeeper, or run `xattr -cr "Health Analytics.app"` before launching.

**Packaged build credentials**: in dev, the main process loads `app/.env` (resolved relative to `__dirname`, walking up from `app/out/main`). That relative path doesn't exist in a packaged app, since `__dirname` sits inside `Contents/Resources/app.asar`. Instead, the packaged app looks for `.env` in its userData directory — on macOS, `~/Library/Application Support/health-analytics-app/.env` — using the same keys as `app/.env.example`. At startup the main process tries `app/.env` first (dev), then falls back to the userData `.env` (packaged), and logs which path (if either) was loaded. This is intentional rather than bundling secrets into the app bundle itself (packaging a `.env` into `extraResources` would ship Supabase credentials inside the distributable, which is a security no-go); instead, place a `.env` file in the userData directory after installing to give a packaged build real credentials.

## Secrets

Copy `.env.example` to `.env` and fill in values; real `.env` files are gitignored everywhere. Never commit keys.
