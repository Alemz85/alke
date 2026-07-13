#!/usr/bin/env python3
"""One-off importer: backfills historical RunKeeper runs (phone GPS, no heart
rate) into `workouts` + `workout_route_points`, so they show up alongside the
Apple Watch / Health Auto Export data the ingest normally writes.

RunKeeper's "export your data" zip has one `cardioActivities.csv` (one row
per activity, units in the header) plus a sibling `.gpx` file per
GPS-tracked activity. Most rows have a GPX file; a handful (manual entries,
pool swims) don't and are imported as aggregate rows with no route.

This is a DELIBERATE second writer of `workouts` (the ingest is the normal
one) — kept safe by a namespaced `external_id` (`runkeeper-<activity id>`)
that can never collide with a Health Auto Export id, and by upserting on
that key so reruns are idempotent: re-running replaces the same workout rows
and wholesale-replaces each workout's route points (delete + reinsert),
never appends duplicates.

Run:
    python scripts/import_runkeeper.py <export_dir> --dry-run   # inspect first
    python scripts/import_runkeeper.py <export_dir>             # writes to the DB

Options:
    --tz TZ                      Local tz the CSV's naive Date is in for
                                  non-GPX (aggregate) rows only — GPX times
                                  are already UTC. Default: UTC.
    --include-non-gps / --no-include-non-gps
                                  Import rows with no GPX file as aggregate
                                  (no-route) workouts. Default: on.

Do NOT run without --dry-run first — a plain run writes to the production
Supabase DB.
"""

from __future__ import annotations

import argparse
import csv
import os
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from metrics.geo import downsample_route, haversine_m  # noqa: E402

GPX_NS = "{http://www.topografix.com/GPX/1/1}"
ROUTE_CAP = 300

TYPE_MAP = {
    "Running": "running",
    "Swimming": "swimming",
    "Cycling": "cycling",
    "Walking": "walking",
}


def normalize_type(raw_type: str) -> str:
    """RunKeeper `Type` -> this repo's snake_case convention. Known types use
    TYPE_MAP; anything else falls back to the general rule (lowercase,
    spaces -> underscores) rather than raising."""
    if raw_type in TYPE_MAP:
        return TYPE_MAP[raw_type]
    return re.sub(r"\s+", "_", raw_type.strip().lower())


def parse_duration_s(text: str) -> int | None:
    """`MM:SS` or `H:MM:SS` -> whole seconds."""
    text = (text or "").strip()
    if not text:
        return None
    parts = text.split(":")
    try:
        parts = [int(p) for p in parts]
    except ValueError:
        return None
    if len(parts) == 2:
        m, s = parts
        return m * 60 + s
    if len(parts) == 3:
        h, m, s = parts
        return h * 3600 + m * 60 + s
    return None


def load_env() -> dict:
    """Same load pattern as chatctx/db.py: prefer a repo-root .env when
    present, fall back to the process environment."""
    env: dict[str, str] = {}
    env_path = pathlib.Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not env.get(key) and os.environ.get(key):
            env[key] = os.environ[key]
    return env


def make_client():
    from supabase import create_client

    env = load_env()
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit(
            "missing SUPABASE_URL/SUPABASE_SERVICE_KEY — set them in the repo-root "
            ".env or export them in the environment"
        )
    return create_client(url, key)


def parse_gpx(path: pathlib.Path) -> list[dict]:
    """Parse a GPX 1.1 track into a list of {lat, lon, elevation_m, time}
    dicts, chronological. Returns [] for a missing/empty/malformed track
    rather than raising — callers treat that as "no usable route"."""
    tree = ET.parse(path)
    root = tree.getroot()
    points = []
    for trkpt in root.iter(f"{GPX_NS}trkpt"):
        lat_s = trkpt.get("lat")
        lon_s = trkpt.get("lon")
        if lat_s is None or lon_s is None:
            continue
        ele_el = trkpt.find(f"{GPX_NS}ele")
        time_el = trkpt.find(f"{GPX_NS}time")
        if time_el is None or not time_el.text:
            continue
        try:
            lat = float(lat_s)
            lon = float(lon_s)
            elevation_m = float(ele_el.text) if ele_el is not None and ele_el.text else None
            t = datetime.strptime(time_el.text.strip(), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        points.append({"lat": lat, "lon": lon, "elevation_m": elevation_m, "time": t})
    return points


def route_distance_m(points: list[dict]) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        total += haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
    return total


def build_gpx_workout(row: dict, gpx_points: list[dict], activity_id: str) -> dict:
    first, last = gpx_points[0], gpx_points[-1]
    duration_s = round((last["time"] - first["time"]).total_seconds())
    distance_m = route_distance_m(gpx_points)
    route = downsample_route(
        [{"lat": p["lat"], "lon": p["lon"], "elevation_m": p["elevation_m"]} for p in gpx_points],
        cap=ROUTE_CAP,
    )
    return {
        "external_id": f"runkeeper-{activity_id}",
        "type": normalize_type(row["Type"]),
        "start_at": first["time"].isoformat().replace("+00:00", "Z"),
        "end_at": last["time"].isoformat().replace("+00:00", "Z"),
        "duration_s": duration_s,
        "distance_m": distance_m,
        "energy_kcal": float(row["Calories Burned"]) if row.get("Calories Burned", "").strip() else None,
        "avg_hr": float(row["Average Heart Rate (bpm)"]) if row.get("Average Heart Rate (bpm)", "").strip() else None,
        "max_hr": None,
        "source": "runkeeper",
        "raw": {
            "_source": "runkeeper",
            "activity_id": activity_id,
            "notes": row.get("Notes") or "",
            "_route_start": {
                "latitude": first["lat"],
                "longitude": first["lon"],
                "timestamp": first["time"].isoformat().replace("+00:00", "Z"),
            },
        },
        "_route_points": route,
    }


def build_aggregate_workout(row: dict, activity_id: str, tz) -> dict | None:
    duration_s = parse_duration_s(row.get("Duration", ""))
    distance_km_text = (row.get("Distance (km)") or "").strip()
    try:
        distance_m = float(distance_km_text) * 1000 if distance_km_text else None
    except ValueError:
        distance_m = None
    date_text = (row.get("Date") or "").strip()
    if not date_text:
        return None
    try:
        naive = datetime.strptime(date_text, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    start_local = naive.replace(tzinfo=tz)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = start_utc
    if duration_s is not None:
        from datetime import timedelta

        end_utc = start_utc + timedelta(seconds=duration_s)
    return {
        "external_id": f"runkeeper-{activity_id}",
        "type": normalize_type(row["Type"]),
        "start_at": start_utc.isoformat().replace("+00:00", "Z"),
        "end_at": end_utc.isoformat().replace("+00:00", "Z"),
        "duration_s": duration_s,
        "distance_m": distance_m,
        "energy_kcal": float(row["Calories Burned"]) if row.get("Calories Burned", "").strip() else None,
        "avg_hr": float(row["Average Heart Rate (bpm)"]) if row.get("Average Heart Rate (bpm)", "").strip() else None,
        "max_hr": None,
        "source": "runkeeper",
        "raw": {
            "_source": "runkeeper",
            "activity_id": activity_id,
            "notes": row.get("Notes") or "",
        },
        "_route_points": None,
    }


def write_workout(sb, workout: dict) -> None:
    route_points = workout.pop("_route_points", None)
    result = sb.table("workouts").upsert(workout, on_conflict="external_id").execute()
    workout_id = result.data[0]["id"]
    if route_points is not None:
        sb.table("workout_route_points").delete().eq("workout_id", workout_id).execute()
        if route_points:
            rows = [
                {
                    "workout_id": workout_id,
                    "seq": p["seq"],
                    "lat": p["lat"],
                    "lon": p["lon"],
                    "elevation_m": p["elevation_m"],
                }
                for p in route_points
            ]
            sb.table("workout_route_points").insert(rows).execute()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("export_dir", help="Path to the RunKeeper export directory")
    parser.add_argument("--dry-run", action="store_true", help="Parse and summarize only; no DB writes")
    parser.add_argument("--tz", default="UTC", help="Local tz for non-GPX rows' naive Date (default: UTC)")
    non_gps = parser.add_mutually_exclusive_group()
    non_gps.add_argument("--include-non-gps", dest="include_non_gps", action="store_true", default=True)
    non_gps.add_argument("--no-include-non-gps", dest="include_non_gps", action="store_false")
    args = parser.parse_args()

    export_dir = pathlib.Path(args.export_dir)
    csv_path = export_dir / "cardioActivities.csv"
    if not csv_path.exists():
        sys.exit(f"cardioActivities.csv not found under {export_dir}")

    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(args.tz)
    except Exception as e:  # pragma: no cover - bad --tz value
        sys.exit(f"invalid --tz {args.tz!r}: {e}")

    sb = None if args.dry_run else make_client()

    total = 0
    with_route = 0
    aggregate = 0
    skipped: list[tuple[str, str]] = []
    samples: list[dict] = []

    with csv_path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            total += 1
            activity_id = row.get("Activity Id", "").strip()
            if not activity_id:
                skipped.append(("<missing activity id>", "no Activity Id"))
                continue

            gpx_name = (row.get("GPX File") or "").strip()
            workout = None

            try:
                if gpx_name:
                    gpx_path = export_dir / gpx_name
                    if not gpx_path.exists():
                        skipped.append((activity_id, f"GPX file missing on disk: {gpx_name}"))
                    else:
                        gpx_points = parse_gpx(gpx_path)
                        if len(gpx_points) < 2:
                            skipped.append((activity_id, "GPX has fewer than 2 usable trackpoints"))
                        else:
                            workout = build_gpx_workout(row, gpx_points, activity_id)
                            with_route += 1
                elif args.include_non_gps:
                    workout = build_aggregate_workout(row, activity_id, tz)
                    if workout is None:
                        skipped.append((activity_id, "aggregate row missing/malformed Date"))
                    else:
                        aggregate += 1
                else:
                    skipped.append((activity_id, "no GPX file; --no-include-non-gps"))
            except Exception as e:  # noqa: BLE001 - keep going for the rest of the import
                skipped.append((activity_id, f"unexpected error: {e}"))
                workout = None

            if workout is None:
                continue

            if len(samples) < 3:
                samples.append(
                    {
                        "activity_id": activity_id,
                        "type": workout["type"],
                        "start_at": workout["start_at"],
                        "distance_m": round(workout["distance_m"], 1) if workout["distance_m"] is not None else None,
                        "duration_s": workout["duration_s"],
                        "points": len(workout["_route_points"]) if workout.get("_route_points") else 0,
                        "csv_distance_km": row.get("Distance (km)"),
                    }
                )

            if not args.dry_run:
                try:
                    write_workout(sb, workout)
                except Exception as e:  # noqa: BLE001
                    skipped.append((activity_id, f"write failed: {e}"))

    print("RunKeeper import summary")
    print(f"  total rows:            {total}")
    print(f"  imported with route:   {with_route}")
    print(f"  imported aggregate:    {aggregate}")
    print(f"  skipped:               {len(skipped)}")
    if skipped:
        for activity_id, reason in skipped:
            print(f"    - {activity_id}: {reason}")
    print(f"  mode:                  {'DRY RUN (no writes)' if args.dry_run else 'WROTE to DB'}")

    if samples:
        print("\n  sample computed values:")
        for s in samples:
            print(
                f"    - {s['activity_id']}: {s['type']}, start_at={s['start_at']}, "
                f"distance_m={s['distance_m']} (csv={s['csv_distance_km']} km), "
                f"duration_s={s['duration_s']}, points={s['points']}"
            )


if __name__ == "__main__":
    main()
