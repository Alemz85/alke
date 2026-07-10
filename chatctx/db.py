#!/usr/bin/env python3
"""Read-only query helper for chat sessions. Usage: python3 db.py "SELECT ..."

Runs the SQL through the database's exec_readonly_sql function (SELECT/WITH
only — anything else is rejected server-side) and prints a markdown table
capped at 200 rows. Stdlib only; credentials come from ./.env (gitignored)."""

import json
import pathlib
import sys
import urllib.error
import urllib.request

ROW_CAP = 200


def load_env() -> dict:
    env = {}
    env_path = pathlib.Path(__file__).parent / ".env"
    if not env_path.exists():
        sys.exit("chatctx/.env missing — copy .env.example and fill in credentials")
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def run_query(sql: str) -> list[dict]:
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
        sys.exit(f"query failed: {detail}")


def to_markdown(rows: list[dict]) -> str:
    if not rows:
        return "_no rows_"
    truncated = len(rows) > ROW_CAP
    rows = rows[:ROW_CAP]
    columns = list(rows[0].keys())
    lines = [
        "| " + " | ".join(columns) + " |",
        "| " + " | ".join("---" for _ in columns) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(_cell(row.get(c)) for c in columns) + " |")
    if truncated:
        lines.append(f"\n_({ROW_CAP} of more rows shown — narrow the query)_")
    return "\n".join(lines)


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value)
    return str(value).replace("|", "\\|").replace("\n", " ")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit('usage: python3 db.py "SELECT ..."')
    print(to_markdown(run_query(sys.argv[1])))
