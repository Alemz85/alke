# Shared data context — schema, metric definitions, quirks

Loaded by every data-touching mode.

## How to use the helper scripts

`db.py`, `gym.py`, `injuries.py`, `goals.py` and `agent_log.py` are **fast paths for common operations** — they exist so you can do the usual things in one command without re-deriving the schema every session. They are NOT a list of the only things you are allowed to do, and the verbs documented here are not the edge of your judgement.

Concretely, you may and should:

- **Read the helper's source and `--help`.** Both outrank this file: the docs go stale, the tool does not. If a documented invocation and the tool disagree, the tool is right — follow it and log the drift (`agent_log.py`, `--category instructions`).
- **Query `information_schema`** to check what a table actually has before trusting a column list written down here. The documented schema below has been wrong before.
- **Reason from the underlying tables** when no helper verb fits. Say plainly that the helper has no path for what's needed, then do the direct thing (a scoped PostgREST write, a targeted `PATCH`) rather than bending the user's request into a verb that happens to exist. Reshaping a request to fit an available command is worse than reaching past it — that is how a request for a template edit turns into an unasked-for recovery-plan write.
- **Tell the user when a capability is genuinely missing**, so it gets built. Log it (`agent_log.py --category tool`). Do not tell them a correction is impossible until you have checked the tool itself — twice now, the verb existed.

Two guardrails are deliberate and do not bend:

- **`db.py` is read-only.** Writes go through the scoped helpers or a deliberate, explained direct write — never by trying to smuggle a mutation through `db.py`.
- **Never fabricate what the user reported.** Pain levels, reps, weights, dates: log what they said, leave the rest null. A plausible number you invented is worse than a blank field.

## Rich blocks — showing data and proposing changes in the app chat

The in-app chat renders special fenced code blocks as real UI cards. The fence's info string names the block type; the body is strict JSON (complete, no comments, no trailing commas). A malformed block degrades to raw JSON in front of the user, so validate shape before emitting. These render only in the in-app chat — in a headless run there is no one to see or click them, so never emit them there.

**Reference blocks** show live app data inline. Use one when you cite a specific workout or a metric trend — the card fetches the real numbers by id, so it cannot drift from the database. Every id must come from a query you actually ran this session; an invented id renders as a broken card.

````
```alke:workout
{"workout_id": "<workouts.id>", "label": "optional caption"}
```
````

````
```alke:metric
{"metric": "ctl", "days": 90, "label": "optional caption"}
```
````

`metric` must be one of: `resting_hr`, `hrv_sdnn_ms`, `respiratory_rate`, `sleep_duration_min`, `vo2max`, `steps`, `active_energy_kcal`, `weight_kg`, `body_fat_pct`, `walking_running_distance_m`, `flights_climbed`, `trimp_total`, `ctl`, `atl`, `tsb`, `acwr`, `rhr_dev`, `hrv_dev`. `days` is 14–365, default 56. The card carries the chart and the current value; your prose still carries the takeaway — a block is evidence, not a substitute for the sentence that says what it means.

**Proposal blocks** put a write in front of the user with Confirm/Discard buttons. **In the in-app chat, never run `gym.py template-apply`, `gym.py create-version`, or `injuries.py plan-apply` yourself.** Author the document, validate it with the matching contract (`node workout_template_contract.mjs validate` / `node recovery_plan_contract.mjs validate` — validating without applying is exactly right here), emit the block with your reasoning in the surrounding prose, and end the turn. On Confirm the app runs the very same script with the very same document; on Discard nothing is written. Only apply directly when the session is headless or the user has explicitly told you to skip confirmation.

````
```alke:template
{
  "id": "<short-slug, lowercase letters/digits/hyphens, unique in this reply>",
  "action": "apply",
  "document": { "templates": [ { "name": "…", "exercises": [ … ] } ] }
}
```
````

`document` is exactly the `template-apply` document described below. `action` follows the existing rules: `"apply"` for a brand-new template or an in-place edit of a family's current version; `"create-version"` (with `"base_template_id": "<gym_templates.id>"`) for an upgrade that should keep the family's history.

````
```alke:recovery-plan
{"id": "<slug>", "injury_id": "<injuries.id>", "document": { "approach": "…", "items": [ … ] }}
```
````

`document` is exactly the `plan-apply` document from `modes/injuries.md`.

After a proposal, the decision lands on the message itself — you will not see it in this session. On a later turn, if the outcome matters, check the database (`gym.py template-list`, `injuries.py plan-list`) rather than assuming; never re-apply a proposal on your own. Post-confirm follow-ups stay yours: e.g. `gym.py run-start` for a confirmed template the user will actually follow — do it when you next see the template exists, or tell the user the run can be started from the Gym tab.

## Metric definitions (as computed in this system)

- **TRIMP (Edwards)**: per workout, minutes in each heart-rate zone × the zone number (1–5), summed. Zones are Karvonen: fraction of heart-rate reserve above recent resting HR, with swim samples shifted +10 bpm before classification. It is the system's single training-load unit.
- **CTL / ATL / TSB**: exponentially weighted averages of daily TRIMP with 42-day and 7-day time constants; TSB = CTL − ATL. CTL ≈ fitness trend, ATL ≈ recent fatigue, negative TSB = carrying fatigue.
- **ACWR**: mean TRIMP of the last 7 days ÷ mean of the last 28. Values well above ~1.5 indicate a fast ramp; null with under 21 days of history.
- **EF (efficiency factor)**: swims only — (meters per minute) ÷ average HR, computed only when ≥70% of the session sat in Z1–Z2 and it lasted ≥20 min. Rising EF at constant effort = aerobic base improving.
- **Decoupling**: for EF-eligible swims, HR drift between first and second half of the session ((avgHR₂−avgHR₁)/avgHR₁ × 100). Under ~5% = aerobically steady.
- **HRR60**: heart-rate drop 60s after a workout ends; usually null (the export rarely includes post-workout samples).
- **SWOLF₍25₎**: per swim set, (seconds + 2×strokes) normalized per 25 m of that set. Stored strokes are Apple watch-arm counts (≈ one per stroke cycle); doubling converts to the textbook both-hands convention — exact for freestyle/backstroke, overcounts breast/fly (accepted: freestyle is the assumed stroke, and HAE never exports stroke style). Lower is better at equal effort; compare within similar set distances.
- **sleep_start / sleep_end**: the watch's detected sleep ONSET and final wake — not bedtime, and not time in bed. **Nothing in this database records when the user got into bed**, so onset latency is invisible and `sleep_start` must never be compared against `user_config.bedtime_goal_min`: that comparison silently charges latency to bedtime discipline. It already has — a week of watch-detected onsets was reported as late bedtimes against the bedtime target when the user had in fact been in bed well before onset, i.e. onset latency reported as a habit problem, understating adherence they actually had (agent_log #21). Bedtime is obtainable only by asking the user, and it is worth asking: their bedtime plus the watch's onset yields a latency number neither source holds alone.
- **rhr_dev / hrv_dev**: 7-day median resting HR (or HRV) minus its 60-day baseline median.
- **weight_7d_slope**: body-weight trend in kg/week — the 7-day rolling mean of daily weight (forward-filled up to 3 days to bridge sparse weigh-ins) minus that same rolling mean 7 days earlier. Treated as a slow OUTCOME variable in the insights layer, not a daily driver — correlations test it against sleep, rhr_dev, hrv_dev, and prior training load, not the other way around.

## Schema summary

- `workouts(id, external_id, type, start_at, end_at, duration_s, distance_m, energy_kcal, avg_hr, max_hr, raw, manual_avg_watts, manual_distance_m, manual_incline_pct, manual_end_at)` — types like `pool_swim`, `functional_strength_training`, `indoor_cycling`, `rowing`. The `manual_*` trio is owner-entered in the app's Sessions tab for indoor cardio (watts for indoor bikes, true distance for rower/treadmill, treadmill grade in percent); `manual_distance_m` supersedes `distance_m` for efficiency math but never overwrites it, and a null incline means "not logged", never "flat". `manual_end_at` is a separate kind of correction: the true end of a session the watch kept recording past (owner forgot to press stop). It only ever TRUNCATES — the metrics job stops counting zone time/TRIMP and drops swim sets at that instant and treats the duration as `manual_end_at - start_at`, while `end_at`/`duration_s`/`distance_m` stay exactly as ingested. So when it is set, ALWAYS reason from the corrected duration, not from `duration_s`; a value at or after `end_at` is inert, and null means no correction.
- `workout_hr_samples(workout_id, offset_s, bpm)` — per-second HR traces.
- `workout_swim_samples(workout_id, offset_s, distance_m, strokes)` — per-second swim series for pool swims (meters/strokes attributed to each second; seconds with no row = resting).
- `swim_sets(workout_id, set_index, start_offset_s, duration_s, distance_m, strokes, rest_after_s)` — ingest-detected swim sets (new set after a >10s sampling gap; `rest_after_s` null on the last set). Pace and SWOLF are derived, not stored: `pace_s_per_100m = 100*duration_s/distance_m`; `swolf25 = (duration_s + 2*strokes)/(distance_m/25)` (stored strokes are watch-arm cycles; ×2 converts to both-hands, freestyle assumption).
- `daily_metrics(date, resting_hr, hrv_sdnn_ms, respiratory_rate, sleep_start, sleep_end, sleep_duration_min, sleep_stages, vo2max, steps, active_energy_kcal, wrist_temp_deviation_c, weight_kg, body_fat_pct, walking_running_distance_m, flights_climbed)`. `body_fat_pct` is a percentage 0-100 (not a 0-1 fraction) and only starts partway through the record — it was added to the Health Auto Export selection late, so every earlier date is null and no backfill exists. Never read those nulls as "0% fat" or as a drop from a prior value. `walking_running_distance_m` and `flights_climbed` are the ambulatory-load pair — the only columns that see walking volume and descent, and load-bearing for anything involving knees, ankles, or a trip on foot (a day of heavy stair descent can explain a knee flare that the training-load model shows nothing for).
- `computed_workout(workout_id, time_in_zones, trimp, ef, decoupling_pct, hrr60, power_ef)`. `ef` is speed-based (m/beat); `power_ef` is watts-per-beat from `manual_avg_watts` on indoor rides — different units, never compare or pool them.
- `computed_daily(date, trimp_total, ctl, atl, tsb, acwr, rhr_baseline_60d, rhr_dev, hrv_baseline_60d, hrv_dev, flags)`.
- `insight_correlations(var_x, var_y, lag_days, r, spearman_r, rank_disagree, n, n_eff, p_value, q_value)` — exploratory sweep; prefer `q_value` (BH-corrected, autocorrelation-adjusted via `n_eff`); `rank_disagree` marks pairs whose Pearson r is outlier-driven or nonlinear (trust `spearman_r` there).
- `insight_models(name, spec, coefficients, diagnostics)` — confirmatory layer. For `daily_adjusted_finder`: `diagnostics.candidates[].status` is the surfaced verdict (multi-night persistence over the nightly `raw_status`, so a fresh finding sits at `watch` for a week first), and `diagnostics.placebo` reports shifted null drivers run through identical gates — a nonzero `signal_count` there means promoted insights deserve extra skepticism.
- `user_config(hr_max, swim_hr_offset, zone2_low_frac, zone2_high_frac, zone2_weekly_target_min, sleep_goal_min, bedtime_goal_min, weekly_min_sessions, timezone, about_me, sex, birthdate, height_cm, protein_target_g)` — single row. `about_me` is load-bearing free text for sporting history, current circumstances, and communication preferences; read it rather than inferring a generic athlete profile.
- `blood_panels(collected_on, lab, panel_name, source_file, notes)` / `blood_markers(panel_id, code, label_raw, category, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, method, position)` — the owner's own lab reports, transcribed from PDFs that stay off the network. `code` is a canonical analyte key (`hemoglobin`, `ferritin`, `vitamin_d`) stable across labs and languages; `label_raw` is the name as printed on the report, in the lab's language. `flag` is set only where a comparison was actually defined — a null flag means the range was prose, NOT that the value was normal. **Read the rule below before using any of this.**
- `injuries` / `injury_notes` / `recovery_plan_items` / `plan_item_checks` — see `modes/injuries.md`.
- `goals` / `goal_progress` — see `modes/goals.md`.
- `gym_sessions(workout_id, template_id, performed_at, title, notes, body_parts)` / `gym_sets(session_id, exercise_id, position, reps, duration_s, weight_kg, rpe, is_warmup, is_eccentric, is_unilateral, note)` / `exercises(name, aliases, body_part, primary_muscles, secondary_muscles, equipment, mechanics, movement_pattern, source)` / `gym_templates` + `gym_template_exercises` — user-logged lifting content, attached to synced strength workouts via `workout_id`. Granularity ladder, all deliberate: full per-set logs → set-less quick log against a template → `body_parts` array only ("did legs + core"). Muscle/volume analytics: join `gym_sets` → `exercises` for `primary_muscles`/`movement_pattern` (curated catalog rows have `source='catalog'`; user-typed customs may carry only a name). The user normally logs in the app's Gym tab; you can log on request via `gym.py` (below).

## Logging gym sessions on request

When the user tells you what they lifted ("did legs today — 3×8×80 squats, some lunges"), log it with the scoped helper (`db.py` stays read-only):

```
python3 gym.py list [--days 30]
python3 gym.py log --json '{"date": "2026-07-12", "title": "Legs", "body_parts": ["legs"], "sets": [{"exercise": "back squat", "sets": 3, "reps": 8, "kg": 80}]}'
python3 gym.py delete <session_id>
```

Each set takes exactly one dose measure: `"reps"` or `"secs"` for a hold — `{"exercise": "wall sit", "sets": 3, "secs": 45}`. Never log a hold as `"reps": 1`; a 60-second wall sit and a 1-second twitch would store identically and both would be false.

**A blank weight is not bodyweight.** `gym_sets.weight_kg = null` means two incompatible things — the movement carries no external load (pelvic drop, prone T-raise), or nobody typed the number for a loaded one — and the row itself cannot tell you which. `gym.py list` now reads the exercise's catalog `equipment` and renders them apart: `15xbw` where the movement genuinely carries none, `15x?kg` where the weight is missing (a loaded movement, or one with no equipment recorded — enrich it with `exercise-update --equipment ..`). **Never read `?kg` as a load, and never compare it to a later weighted session as if it were one**: treating a blank Leg Extension as bodyweight invented a load increase and a rep drop that never happened, and a coaching observation got built on top of it (agent_log #17). When it matters, ask the user for the weight rather than inferring one. `log` prints a warning naming any working set left without a weight on a loaded movement.

**Dumbbell/kettlebell weight is PER HAND.** For `equipment = 'dumbbell'` or `'kettlebell'`, `weight_kg` records ONE implement's weight — the number stamped on the dumbbell, the rack increment — never the pair's total. Incline Dumbbell Press with two 10s stores 10, not 20. This has the same silent-error shape as the blank-weight rule above but is worse, because a pair-total LOOKS like a valid load (agent_log #30: pair totals briefly stored made the rows incomparable to any reference). `gym.py list` and template prescriptions render these loads as `14/hand`, and the app's kg field hints "per hand" for these exercises. When the user reports a total ("24 between the two"), normalize to per-hand before writing — and say so.

**Single-arm/-leg sets carry `is_unilateral = true`.** A set performed one side at a time (single-arm cable row on a D-handle, and unilateral progressions like Reverse Lunge, Pelvic Drop, single-leg Wall Sit/Glute Bridge) stores `is_unilateral = true`; its weight is per side. **Never compare a unilateral set's load against bilateral sets of the same exercise** — a single-arm row at half the two-handed load is equipment, not a 50% regression (agent_log #31). `gym.py list` marks these sets `·uni`; log them by putting `"unilateral": true` on the sets entry. The app's Gym editor has a matching "Unilateral" checkbox per exercise block.

Rules: log only what the user actually states — never invent reps/weights; leave fields they didn't give as null (a `body_parts`-only log is valid and better than fabricated sets). Check `gym.py list` first so you don't double-log a session the user already entered in the app; if a synced strength workout exists for that day (`workouts`, type ~ strength/core), pass its id as `workout_id` so the log attaches to it. Exercise names resolve against the `exercises` catalog including aliases; on a no-match the command aborts with suggestions — only add `"create": true` when it's genuinely a new exercise, not a near-miss of an existing one. Sets of exercises linked to recovery-plan items auto-check the day's rehab item (`source='gym'`) — mention it when it happens. `delete` is for correcting your own mis-logs, not for removing the user's app-entered sessions.

## Maintaining the exercise catalog

The `exercises` catalog is yours to write, not only to read from:

```
python3 gym.py exercise-list [--query ".."] [--source user|catalog] [--incomplete]
python3 gym.py exercise-add --name ".." [--body-part ..] [--primary-muscles "quadriceps,glutes"] [--secondary-muscles ".."] [--equipment ..] [--mechanics compound|isolation] [--movement-pattern ..] [--aliases "a,b"]
python3 gym.py exercise-update <name|id> [--rename ".."] [same attribute flags]
```

`exercise-add` mints a complete row directly — you never need to route a catalog addition through a fabricated session or an unrelated recovery-plan item to get one created. `exercise-update` patches only the flags you pass, so it is the way to enrich a row that was created name-only.

**Always fill `primary_muscles`.** The muscle and volume analytics join `gym_sets → exercises` on it, so a row with an empty muscle array is silently dropped from them — nothing errors, the body part just under-reports. `exercise-list --incomplete` lists the rows in that state. The same attributes can be passed inline wherever `"create": true` appears (a `log` set, a template exercise), so a row minted mid-task is as complete as one added deliberately.

## Creating reusable Gym workout templates

When the user asks you to create, save, or add a workout plan/template, the deliverable is database-backed reusable Gym templates, not a prose routine and not logged sessions. Use the complete contract:

```
python3 gym.py template-list
node workout_template_contract.mjs template > /tmp/workout-templates.json
node workout_template_contract.mjs validate /tmp/workout-templates.json
python3 gym.py template-apply --file /tmp/workout-templates.json
```

Before authoring, read active goals, injuries/constraints, relevant training history, and the exercise catalog as needed. Every exercise needs a set count and exactly ONE dose measure: `"reps"` (1-500) or `"secs"` (1-3600) for a prescribed hold. A timed exercise is written as `{"exercise": "Wall Sit", "sets": 3, "secs": 45}` — never as `1 rep` with the duration explained in a note. Leave starting weight null unless the user supplied it or asked for a justified value. Put progression, rep-range context, RIR, rest, and session-duration guidance in template/exercise notes—the expanded card renders exercise notes below the name.

A template may also mint the catalog row it needs: add `"create": true` to that exercise, plus whatever catalog metadata you know (`body_part`, `primary_muscles`, `equipment`, `mechanics`, `movement_pattern`, `aliases`) — same shape and same vocabulary as `exercise-add`. A template write is never blocked because a physio-prescribed movement isn't catalogued yet, and it must not be routed through an unrelated recovery-plan item to get one created. Passing metadata without `"create": true` is rejected: editing an existing row is `exercise-update`'s job.

**In the in-app chat, the final step is a proposal, not an apply**: author and validate the document as above, then emit it as an `alke:template` block (see "Rich blocks") instead of running `template-apply`/`create-version` yourself — the app runs the same command on the user's Confirm.

The Node `validate` step checks document shape only; `template-apply` resolves every catalog exercise before its first write and aborts without changes if any name fails. `template-apply` is idempotent by case-insensitive template name: it updates the named templates and their ordered exercise rows while leaving unrelated templates and every gym session untouched. A template can accumulate several versions (via `create-version`) that all share the same name — `template-apply` matches by name against each family's CURRENT version only, so it edits that version IN PLACE (its own version history is never a "duplicate name" conflict); it still aborts if two different families' current versions genuinely collide on a name. Validate before applying, then run `template-list` to verify the saved result.

To remove a template rather than update it:

```
python3 gym.py template-archive <template_id>
python3 gym.py template-delete <template_id>
```

`template-archive` sets `archived=true` on that one version only — other versions in the family and any runs are untouched. `template-delete` hard-deletes that version and its exercise rows, and refuses (pointing you at `template-archive` instead) if any logged `gym_sessions` or `gym_template_runs` history still references it.

Data quirks: watch data covers only the recent part of the record (check the earliest `daily_metrics` date); resting HR / HRV / sleep exist on ~half of days (watch not always worn); `distance_m` exists only for swims and walks.

**The load model is blind to unlogged walking.** TRIMP comes from a workout's heart-rate zones, so a day with no logged workout scores `trimp_total = 0` no matter how much walking it contained — a long day on foot with tens of thousands of steps and dozens of flights still scores zero. Everything derived from TRIMP inherits that blindness: CTL, ATL, TSB and ACWR all read "rested and fresh" across what may be the highest mechanical-load week in the record. Before reporting freshness or a light week, check `steps` / `walking_running_distance_m` / `flights_climbed` for the same days, and say which kind of load you mean. (The Zone-2 index is the exception — `metrics/models.py` feeds unlogged ambulatory activity into it via daily active energy, so the Z2 index and the CTL family can legitimately disagree about the same week.)

## Blood panels — context only, never interpretation

Lab results are in the database so you have context, not so you can practise
medicine. The line, and it is not a soft one:

- **You may** reference a value as background when it is genuinely relevant to
  something the user raised — e.g. a marker they asked about at the last panel,
  when discussing fatigue in training.
- **You may not** interpret, diagnose, explain what an out-of-range value means,
  speculate about causes, suggest it explains a symptom, or recommend supplements,
  retesting, or any action based on one. That holds even when the user asks
  directly, and even when the answer seems obvious.
- **Anything flagged goes to a doctor.** Say so plainly, once, without hedging or
  lecturing, and move on to what you can help with.

Two things that make silent errors easy here, so check both before quoting a number:

1. **Check the date.** `collected_on` can be years old. A panel from a previous
   training era describes a body that has since changed — never present a stale
   value as current status. Say when it was taken, every time.
2. **A null `flag` does not mean normal.** It means no numeric comparison was
   possible (the report printed the range as prose). Quote `ref_text` as printed
   rather than forming your own verdict.

This matches the app's own framing (`README` "Purpose & scope": informational,
not medical) and the Profile tab, which shows the same values with the same
disclaimer.

## Agent issue log — self-report problems you hit

Observations about broken or misleading things die with the session unless you log them. The `agent_log` table is the bug tracker for that; write to it via the scoped helper (`db.py` stays read-only):

```
python3 agent_log.py log --category knowledge|schema|tool|data|instructions|other --subject ".." --detail ".." [--severity info|issue|blocker] [--session-hint ".."]
python3 agent_log.py list [--category ..] [--unresolved]
python3 agent_log.py counts
python3 agent_log.py resolve <id>
```

`--subject` is the join key for counting repeated flags — use one canonical string per thing: a file path for knowledge entries, the table/column name for schema issues, the tool/helper name for tool issues.

Log, without being asked, when:

- A query or tool invocation fails in a way that suggests a bug or wrong documentation (not a one-off typo you then fixed).
- A schema or metric assumption from your instruction files turns out wrong.
- A knowledge-library entry seems low-quality, inapplicable to this user, or contradicted by better evidence (`--category knowledge`, `--subject <file path>`).
- Data looks wrong in a way worth engineering attention (impossible values, gaps that don't match the known-quirks list above).
- Your instruction files steered you wrong — you missed load-bearing context, or mis-framed an answer, because no mode file told you to look (`--category instructions`, `--subject <mode file path>`). A resolution to "do better next time" dies with the session; the log entry is the only version that survives.

Keep entries objective and short: what was attempted, what happened, what was expected. No editorializing — this is a bug tracker, not a diary. Don't re-log a problem that already has an open entry for the same subject (check `list --unresolved` if unsure); `resolve` is for dev sessions to close entries whose cause is fixed, not for you.
