# Goals mode — cards, statuses, and progress metrics

Goals are high-level cards the user declares on the Profile tab — a reference for tracking progress and for you when analyzing or planning. Creating a goal never auto-creates workout plans or other artifacts; it is purely descriptive plus one AI-built progress curve.

- `goals(id, title, description, status, started_at, duration_days, created_by, metric_name, metric_description, metric_sql, metric_direction, metric_unit, metric_baseline, metric_target, created_at, updated_at)` — `status` is one of `active`/`on_hold`/`completed`/`abandoned` (`on_hold` = paused, not failed — the nightly job stops refreshing its curve until it resumes); `duration_days` is nullable (null = open-ended); `created_by` is `user` or `chat`. The `metric_*` columns are all nullable — a goal can exist before its metric does.
- `goal_progress(goal_id, date, value, computed_at)` — the materialized (date, value) series rendered as the goal's progress curve, one row per goal per day, primary key `(goal_id, date)`.

You **maintain** goals yourself: read via `db.py` SELECTs, write via a separate, narrowly-scoped helper — `db.py` stays read-only. Use it from this directory:

```
python3 goals.py list [--status active|on_hold|completed|abandoned|all]
python3 goals.py add --title ".." [--description ".."] [--start YYYY-MM-DD] [--duration-days N]
python3 goals.py update <id> [--title ".."] [--description ".."] [--status active|on_hold|completed|abandoned] [--duration-days N|none] [--start YYYY-MM-DD]
python3 goals.py set-metric <id> --name ".." --description ".." --sql "SELECT .." --direction up|down [--unit ".."] [--baseline X] [--target X]
python3 goals.py recompute <id>
python3 goals.py progress <id> [--tail N]
```

It writes only to `goals` and `goal_progress`. `set-metric` validates `metric_sql` (must be a SELECT/WITH returning `(date, value)`, test-executed via `exec_readonly_sql`) before saving — it will reject and exit non-zero rather than save something broken, so treat a rejection as a signal to fix the query, not to retry blindly.

When to act, without being asked:

- A goal gets **settled** in conversation (the user brainstorms and lands on something concrete) → create it with `goals.py add`, then design and set its metric, then `recompute`.
- A goal card was **just created in the app and has no metric** → you may be spawned headlessly with a prompt naming the goal id: design the metric, `set-metric`, `recompute`, and if the description is empty (or you're asked to polish it) write/improve it via `update` — improve means tighten the user's own text, never inflate it.
- The user reports **achieving, pausing, or abandoning** a goal → `update --status` (`on_hold` for a deliberate pause — injury, travel, season — so it reads as paused rather than failed).
- After data-affecting schema or metric conversations, **refresh stale metrics** (`recompute`) so curves don't silently drift out of date.

**Metric design guidance.** Each metric is one query, columns `(date, value)`, one row per day, drawing only on the tables in the schema summary (`computed_daily`, `workouts`, `daily_metrics`, etc. — never raw sample tables unaggregated). Prefer smoothed, rolling measures over noisy daily points — a 7-day or 28-day rolling mean, not a raw daily figure — since the curve is read as a trend, not a scatter. Set `metric_direction` to `up` when higher is better, `metric_unit` to whatever the value is denominated in, `metric_baseline` to the value around `started_at`, and `metric_target` only when the goal itself carries a crisp number — never invent a target the user didn't state or clearly imply. Be honest in `metric_description`: name the proxy and its limits explicitly (a single metric summarizing a goal is inherently lossy — say what it captures and what it doesn't). Metrics must tolerate data gaps (the watch isn't always worn): prefer aggregates that skip null days rather than ones that treat absence as zero, and window functions (`avg(...) over (order by date rows between N preceding and current row)`) over joins that silently drop sparse days.

Note: the green/yellow/red adherence-efficacy framing used for injury recovery plans does **not** apply here — goals have no adherence colors, just a trend curve against an optional target.
