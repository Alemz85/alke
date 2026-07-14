#!/usr/bin/env python3
"""Write helper for goal cards — the chat agent maintains goals with this.

`db.py` is read-only (SELECT via RPC); this is the write path, hitting the
PostgREST REST API directly with the service key. Table names are hardcoded
(goals, goal_progress). Stdlib only; credentials come from ./.env when
present, else the process environment (same resolution as db.py).

A goal's progress metric is an AI-authored SQL query (`metric_sql`) that
must return columns (date, value), one row per day. It is validated and
test-executed through the hardened `exec_readonly_sql` RPC before being
saved, and materialized into `goal_progress` by `recompute`.

Subcommands:
  list        [--status ..]              list goals as a markdown table
  add         --title ... [options]      create a goal, prints its id
  update      <id> [options]             patch a goal (only given fields)
  set-metric  <id> --name .. --sql ..    validate + save a goal's progress metric
  recompute   <id>                       (re)run metric_sql, upsert into goal_progress
  progress    <id> [--tail N]            print the newest N progress points
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
SQL_LEAD_RE = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UPSERT_CHUNK = 500


def load_env() -> dict:
    env = {}
    env_path = pathlib.Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    if not all(env.get(k) for k in REQUIRED_KEYS):
        for key in REQUIRED_KEYS:
            if os.environ.get(key):
                env[key] = os.environ[key]
    if not all(env.get(k) for k in REQUIRED_KEYS):
        sys.exit(
            "missing SUPABASE_URL/SUPABASE_SERVICE_KEY — set chatctx/.env "
            "(copy .env.example and fill in credentials) or export them in the environment"
        )
    return env


def _request(method: str, path: str, *, params: dict | None = None, body: dict | None = None,
             prefer: str | None = None, on_conflict: str | None = None) -> list[dict]:
    env = load_env()
    url = f"{env['SUPABASE_URL']}/rest/v1/{path}"
    all_params = dict(params or {})
    if on_conflict:
        all_params["on_conflict"] = on_conflict
    if all_params:
        url += "?" + urllib.parse.urlencode(all_params)
    key = env["SUPABASE_SERVICE_KEY"]
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        try:
            detail = json.loads(detail).get("message", detail)
        except json.JSONDecodeError:
            pass
        sys.exit(f"request failed ({e.code}): {detail}")


def _exec_readonly_sql(sql: str) -> list[dict]:
    """Test-execute a metric_sql query through the hardened RPC. Returns the
    row list on success; exits non-zero with the server's error on failure."""
    env = load_env()
    url = f"{env['SUPABASE_URL']}/rest/v1/rpc/exec_readonly_sql"
    key = env["SUPABASE_SERVICE_KEY"]
    body = json.dumps({"query": sql.rstrip().rstrip(";")}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        try:
            detail = json.loads(detail).get("message", detail)
        except json.JSONDecodeError:
            pass
        sys.exit(f"metric_sql validation failed: {detail}")


def cmd_list(args) -> None:
    params = {
        "select": "id,title,status,started_at,duration_days,metric_name,created_by",
        "order": "status,started_at.desc",
    }
    if args.status != "all":
        params["status"] = f"eq.{args.status}"
    rows = _request("GET", "goals", params=params)
    if not rows:
        print("_no goals_")
        return
    print("| id | title | status | started | duration_days | metric | created_by |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        duration = "" if r.get("duration_days") is None else r["duration_days"]
        metric = r.get("metric_name") or "(no metric)"
        print(f"| {r['id']} | {r.get('title') or ''} | {r.get('status') or ''} | "
              f"{r.get('started_at') or ''} | {duration} | {metric} | {r.get('created_by') or ''} |")


def cmd_add(args) -> None:
    body = {"title": args.title, "created_by": "chat"}
    for field, value in (
        ("description", args.description), ("started_at", args.start), ("duration_days", args.duration_days),
    ):
        if value is not None:
            body[field] = value
    rows = _request("POST", "goals", body=body, prefer="return=representation")
    print(f"created goal {rows[0]['id']}")


def cmd_update(args) -> None:
    body = {"updated_at": "now()"}
    for field, value in (
        ("title", args.title), ("description", args.description), ("status", args.status),
        ("started_at", args.start),
    ):
        if value is not None:
            body[field] = value
    if args.duration_days is not None:
        body["duration_days"] = None if args.duration_days == "none" else int(args.duration_days)
    _request("PATCH", "goals", params={"id": f"eq.{args.id}"}, body=body, prefer="return=minimal")
    print(f"updated goal {args.id}")


def cmd_set_metric(args) -> None:
    sql = args.sql
    if not SQL_LEAD_RE.match(sql):
        sys.exit("invalid metric_sql — must start with SELECT or WITH")

    result = _exec_readonly_sql(sql)
    if not isinstance(result, list):
        sys.exit(f"invalid metric_sql — expected a list of rows, got {type(result).__name__}")

    for i, row in enumerate(result):
        if not isinstance(row, dict) or "date" not in row or "value" not in row:
            sys.exit(f"invalid metric_sql — row {i} missing 'date'/'value' keys: {row!r}")
        if row["value"] is None:
            sys.exit(f"invalid metric_sql — row {i} has null value: {row!r}")
        try:
            float(row["value"])
        except (TypeError, ValueError):
            sys.exit(f"invalid metric_sql — row {i} value not parseable as float: {row!r}")
        date_str = str(row["date"])[:10]
        if not DATE_RE.match(date_str):
            sys.exit(f"invalid metric_sql — row {i} date not parseable as YYYY-MM-DD: {row!r}")

    body = {
        "metric_name": args.name,
        "metric_description": args.description,
        "metric_sql": sql,
        "metric_direction": args.direction,
        "updated_at": "now()",
    }
    for field, value in (("metric_unit", args.unit), ("metric_baseline", args.baseline),
                          ("metric_target", args.target)):
        if value is not None:
            body[field] = value
    _request("PATCH", "goals", params={"id": f"eq.{args.id}"}, body=body, prefer="return=minimal")
    print(f"set metric for goal {args.id} ({len(result)} row(s) validated)")


def cmd_recompute(args) -> None:
    rows = _request("GET", "goals", params={"id": f"eq.{args.id}", "select": "metric_sql"})
    if not rows:
        sys.exit(f"no goal with id {args.id}")
    sql = rows[0].get("metric_sql")
    if not sql:
        sys.exit(f"goal {args.id} has no metric_sql set — run set-metric first")

    result = _exec_readonly_sql(sql)
    if not isinstance(result, list):
        sys.exit(f"metric_sql did not return a list of rows, got {type(result).__name__}")

    points = []
    for row in result:
        if not isinstance(row, dict):
            continue
        value = row.get("value")
        if value is None:
            continue
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        date_str = str(row.get("date") or "")[:10]
        if not DATE_RE.match(date_str):
            continue
        points.append({"goal_id": args.id, "date": date_str, "value": value})

    if not points:
        print(f"recomputed goal {args.id}: 0 points written")
        return

    for i in range(0, len(points), UPSERT_CHUNK):
        chunk = points[i:i + UPSERT_CHUNK]
        _request("POST", "goal_progress", body=chunk, prefer="resolution=merge-duplicates,return=minimal",
                  on_conflict="goal_id,date")

    dates = sorted(p["date"] for p in points)
    print(f"recomputed goal {args.id}: {len(points)} point(s) written, range {dates[0]} to {dates[-1]}")


def cmd_progress(args) -> None:
    rows = _request("GET", "goal_progress", params={
        "goal_id": f"eq.{args.id}",
        "select": "date,value",
        "order": "date.desc",
        "limit": str(args.tail),
    })
    if not rows:
        print("_no progress points_")
        return
    rows = list(reversed(rows))
    print("| date | value |")
    print("| --- | --- |")
    for r in rows:
        print(f"| {r.get('date') or ''} | {r.get('value')} |")


def main() -> None:
    parser = argparse.ArgumentParser(description="Goal card write helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="List goals")
    p_list.add_argument("--status", choices=["active", "on_hold", "completed", "abandoned", "all"], default="all")
    p_list.set_defaults(func=cmd_list)

    p_add = sub.add_parser("add", help="Create a new goal")
    p_add.add_argument("--title", required=True)
    p_add.add_argument("--description")
    p_add.add_argument("--start", help="YYYY-MM-DD")
    p_add.add_argument("--duration-days", dest="duration_days", type=int)
    p_add.set_defaults(func=cmd_add)

    p_upd = sub.add_parser("update", help="Update an existing goal")
    p_upd.add_argument("id")
    p_upd.add_argument("--title")
    p_upd.add_argument("--description")
    p_upd.add_argument("--status", choices=["active", "on_hold", "completed", "abandoned"])
    p_upd.add_argument("--duration-days", dest="duration_days", help="integer, or 'none' to clear")
    p_upd.add_argument("--start", help="YYYY-MM-DD")
    p_upd.set_defaults(func=cmd_update)

    p_metric = sub.add_parser("set-metric", help="Validate and save a goal's progress metric")
    p_metric.add_argument("id")
    p_metric.add_argument("--name", required=True)
    p_metric.add_argument("--description", required=True)
    p_metric.add_argument("--sql", required=True, help="SELECT/WITH returning (date, value)")
    p_metric.add_argument("--direction", required=True, choices=["up", "down"])
    p_metric.add_argument("--unit")
    p_metric.add_argument("--baseline", type=float)
    p_metric.add_argument("--target", type=float)
    p_metric.set_defaults(func=cmd_set_metric)

    p_recompute = sub.add_parser("recompute", help="(Re)run metric_sql and upsert goal_progress")
    p_recompute.add_argument("id")
    p_recompute.set_defaults(func=cmd_recompute)

    p_progress = sub.add_parser("progress", help="Print a goal's newest progress points")
    p_progress.add_argument("id")
    p_progress.add_argument("--tail", type=int, default=14)
    p_progress.set_defaults(func=cmd_progress)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
