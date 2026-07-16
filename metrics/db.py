"""Supabase I/O for the metrics job. All reads paginate past PostgREST's
1000-row page; all writes upsert in chunks so reruns are idempotent."""

from __future__ import annotations

import os

from supabase import Client, create_client

PAGE = 1000
WRITE_CHUNK = 500


def client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return create_client(url, key)


def _fetch_all(query_builder_factory) -> list[dict]:
    rows: list[dict] = []
    while True:
        page = query_builder_factory().range(len(rows), len(rows) + PAGE - 1).execute().data
        rows.extend(page)
        if len(page) < PAGE:
            return rows


def fetch_user_config(sb: Client) -> dict:
    return sb.table("user_config").select("*").eq("id", 1).single().execute().data


def fetch_workouts(sb: Client, since_iso: str | None) -> list[dict]:
    def q():
        query = sb.table("workouts").select(
            "id, external_id, type, start_at, end_at, duration_s, distance_m, avg_hr, max_hr"
        )
        if since_iso:
            query = query.gte("start_at", since_iso)
        return query.order("start_at")

    return _fetch_all(q)


def fetch_hr_samples(sb: Client, workout_ids: list[str]) -> dict[str, list[tuple[int, float]]]:
    out: dict[str, list[tuple[int, float]]] = {w: [] for w in workout_ids}
    for i in range(0, len(workout_ids), 50):
        chunk = workout_ids[i : i + 50]

        def q(chunk=chunk):
            return (
                sb.table("workout_hr_samples")
                .select("workout_id, offset_s, bpm")
                .in_("workout_id", chunk)
                .order("workout_id")
                .order("offset_s")
            )

        for row in _fetch_all(q):
            out[row["workout_id"]].append((row["offset_s"], float(row["bpm"])))
    return out


def fetch_daily_metrics(sb: Client) -> list[dict]:
    def q():
        return sb.table("daily_metrics").select(
            "date, resting_hr, hrv_sdnn_ms, sleep_start, sleep_end, sleep_duration_min, weight_kg, vo2max, steps"
        ).order("date")

    return _fetch_all(q)


def update_hr_max(sb: Client, hr_max: int) -> None:
    sb.table("user_config").update({"hr_max": hr_max}).eq("id", 1).execute()


def upsert_computed_workouts(sb: Client, rows: list[dict]) -> None:
    for i in range(0, len(rows), WRITE_CHUNK):
        sb.table("computed_workout").upsert(rows[i : i + WRITE_CHUNK]).execute()


def upsert_computed_daily(sb: Client, rows: list[dict]) -> None:
    for i in range(0, len(rows), WRITE_CHUNK):
        sb.table("computed_daily").upsert(rows[i : i + WRITE_CHUNK]).execute()


def fetch_computed_workouts(sb: Client) -> list[dict]:
    def q():
        return sb.table("computed_workout").select(
            "workout_id, trimp, ef, decoupling_pct, hrr60"
        ).order("workout_id")

    return _fetch_all(q)


def fetch_computed_workout_zones(sb: Client) -> dict[str, dict]:
    """time_in_zones jsonb per workout — the Zone-2 model's core input (spec §8).
    Keyed by workout_id."""

    def q():
        return sb.table("computed_workout").select("workout_id, time_in_zones").order("workout_id")

    return {r["workout_id"]: (r.get("time_in_zones") or {}) for r in _fetch_all(q)}


def fetch_zone2_fitness_params(sb: Client) -> dict:
    """Single-row fitted/literature parameters (spec §9). Falls back to {} if the
    row is somehow absent, letting callers apply literature defaults."""
    rows = sb.table("zone2_fitness_params").select("*").eq("id", 1).execute().data
    return rows[0] if rows else {}


def update_zone2_fitted_from(sb: Client, fitted_from: dict) -> None:
    """Persist the params row's `fitted_from` jsonb — the lifetime-extreme store
    the durable baselines ratchet against (never shrinks; only widens). Kept in the
    existing jsonb column so no schema change is needed."""
    sb.table("zone2_fitness_params").update({"fitted_from": fitted_from}).eq("id", 1).execute()


def fetch_active_injury_holds(sb: Client) -> dict:
    """State for the zone2_maintenance suppression rule (spec §5c.4). Returns
    counts of active injuries and active training-constraint plan items; the
    caller suppresses the nudge when either is non-empty (an injury/plan hold
    must never read as pressure to train)."""
    injuries = (
        sb.table("injuries").select("id, status").eq("status", "active").execute().data
    )
    constraints = (
        sb.table("recovery_plan_items")
        .select("id, kind, active")
        .eq("active", True)
        .eq("kind", "constraint")
        .execute()
        .data
    )
    return {
        "active_injuries": len(injuries),
        "active_constraints": len(constraints),
    }


def upsert_computed_zone2_fitness(sb: Client, rows: list[dict]) -> None:
    for i in range(0, len(rows), WRITE_CHUNK):
        sb.table("computed_zone2_fitness").upsert(rows[i : i + WRITE_CHUNK], on_conflict="date").execute()


# Columns the insight_correlations table actually has. compute_correlations now
# also returns n_eff / p_value_naive / q_value (F3), but persisting those needs a
# migration (out of the metrics surface); until that lands, project each row to the
# known columns so the write stays valid. p_value already carries the CORRECTED
# (effective-n) value, so the overconfidence fix reaches the DB today; q_value is
# available in the return value for callers and will be stored once the columns exist.
INSIGHT_CORR_COLUMNS = (
    "computed_at", "var_x", "var_y", "lag_days", "r", "n", "p_value",
    "n_eff", "p_value_naive", "q_value",
)


def replace_insight_correlations(sb: Client, rows: list[dict]) -> None:
    """SPEC: the exploratory table is overwritten each nightly run."""
    projected = [{k: row[k] for k in INSIGHT_CORR_COLUMNS if k in row} for row in rows]
    sb.table("insight_correlations").delete().neq("lag_days", -1).execute()
    for i in range(0, len(projected), WRITE_CHUNK):
        sb.table("insight_correlations").insert(projected[i : i + WRITE_CHUNK]).execute()


def upsert_insight_model(sb: Client, row: dict) -> None:
    sb.table("insight_models").upsert(row).execute()


def fetch_active_goals(sb: Client) -> list[dict]:
    return (
        sb.table("goals")
        .select("id, metric_sql")
        .eq("status", "active")
        .not_.is_("metric_sql", "null")
        .execute()
        .data
    )


def exec_readonly(sb: Client, sql: str) -> list[dict]:
    """Evaluate agent-authored SQL via the hardened exec_readonly_sql RPC
    (SELECT-only, read-only txn). Never run goal metric_sql any other way."""
    return sb.rpc("exec_readonly_sql", {"query": sql}).execute().data


def upsert_goal_progress(sb: Client, rows: list[dict]) -> None:
    for i in range(0, len(rows), WRITE_CHUNK):
        sb.table("goal_progress").upsert(rows[i : i + WRITE_CHUNK], on_conflict="goal_id,date").execute()


def fetch_workouts_needing_geo(sb: Client) -> list[dict]:
    """Workouts with a start coordinate but no workout_geo row yet — the
    nightly geocoding job's input. Prefers workout_route_points (seq=0) over
    the raw._route_start fallback when both exist. Volume is dozens, so the
    anti-join against the geocoded set is done in Python rather than SQL."""
    geocoded_ids = {r["workout_id"] for r in _fetch_all(lambda: sb.table("workout_geo").select("workout_id"))}

    starts: dict[str, dict] = {}

    # fallback source first so the route_points source (preferred) overwrites it
    def q_raw():
        return sb.table("workouts").select("id, raw")

    for row in _fetch_all(q_raw):
        raw = row.get("raw") or {}
        route_start = raw.get("_route_start") if isinstance(raw, dict) else None
        if not route_start:
            continue
        lat = route_start.get("latitude")
        lon = route_start.get("longitude")
        if lat is None or lon is None:
            continue
        starts[row["id"]] = {"workout_id": row["id"], "lat": lat, "lon": lon}

    def q_points():
        return sb.table("workout_route_points").select("workout_id, lat, lon").eq("seq", 0)

    for row in _fetch_all(q_points):
        starts[row["workout_id"]] = {
            "workout_id": row["workout_id"],
            "lat": row["lat"],
            "lon": row["lon"],
        }

    return [s for wid, s in starts.items() if wid not in geocoded_ids]


def upsert_workout_geo(sb: Client, rows: list[dict]) -> None:
    for i in range(0, len(rows), WRITE_CHUNK):
        sb.table("workout_geo").upsert(rows[i : i + WRITE_CHUNK], on_conflict="workout_id").execute()
