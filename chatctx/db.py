#!/usr/bin/env python3
"""Read-only query helper for chat sessions. Usage: python3 db.py "SELECT ..."

Runs the SQL through the database's exec_readonly_sql function (SELECT/WITH
only — anything else is rejected server-side) and prints a markdown table
capped at 200 rows. Stdlib only; credentials come from ./.env (gitignored)
when present, else from the process environment (the packaged Electron app
spawns this CLI with SUPABASE_URL / SUPABASE_SERVICE_KEY already in its env,
since chatctx/.env is never bundled into the packaged app — see
electron-builder.yml)."""

import http.client
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROW_CAP = 200
REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")

# PostgREST chunked responses sometimes abort mid-transfer, raising
# http.client.IncompleteRead — the connection died, not a server error, so the
# HTTPError branch below never sees it and the agent got a raw traceback
# instead of rows (agent_log #25: ~8 hits in one session across every helper,
# response-size correlated, and the identical query succeeded on retry).
# Truncated bytes are unparseable JSON, so the whole request is replayed.
#
# Retrying is unconditionally safe here in a way it is not in the write
# helpers: exec_readonly_sql only accepts SELECT/WITH, so a replay cannot
# double-apply anything. gym.py/injuries.py restrict retries to GET for that
# reason.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_S = 0.5
# json.JSONDecodeError belongs here for the same reason: a body that arrives
# truncated but with a clean connection close fails at the parse, not the read.
TRANSIENT_ERRORS = (http.client.HTTPException, urllib.error.URLError, OSError,
                    json.JSONDecodeError)


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


def run_query(sql: str) -> list[dict]:
    env = load_env()
    url = f"{env['SUPABASE_URL']}/rest/v1/rpc/exec_readonly_sql"
    key = env["SUPABASE_SERVICE_KEY"]
    body = json.dumps({"query": sql.rstrip().rstrip(";")}).encode()
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        req = urllib.request.Request(url, data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            # A real HTTP status: deterministic, so report it rather than retry.
            detail = e.read().decode()
            try:
                detail = json.loads(detail).get("message", detail)
            except json.JSONDecodeError:
                pass
            sys.exit(f"query failed: {detail}")
        except TRANSIENT_ERRORS as e:
            if attempt == RETRY_ATTEMPTS:
                # A clean one-line error, not a traceback: this prints into a
                # chat transcript the user reads.
                sys.exit(f"query failed after {attempt} attempt(s): {type(e).__name__}: {e}")
            time.sleep(RETRY_BACKOFF_S * 2 ** (attempt - 1))
    raise AssertionError("unreachable")  # the loop returns or sys.exits


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
