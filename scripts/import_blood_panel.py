#!/usr/bin/env python3
"""Import a blood panel into blood_panels / blood_markers.

Input is a REVIEWED JSON file, not a PDF. That split is deliberate. Lab
reports come in incompatible layouts, and at least one of the owner's labs
produces a PDF whose text layer fuses adjacent columns — "12.34.5" is the
reference bound 12.3 followed by the value 4.5, with nothing between them. A
heuristic that guesses where to split is exactly the wrong tool for medical
numbers: a silent off-by-one-digit here is worse than any amount of manual work.
So transcription (eyes on the rendered report) and writing (this script) are
separate steps, and the JSON is the reviewable artifact in between.

`--dry-run` prints the parsed panel as a table and writes nothing; run it first.

Usage:
  python3 scripts/import_blood_panel.py <panel.json> [--dry-run]

Credentials resolve like the other helpers: ./.env when present, else the
process environment. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
VALID_FLAGS = ("low", "normal", "high", "abnormal")


def load_env() -> dict:
    env = {}
    for candidate in (pathlib.Path.cwd() / ".env", pathlib.Path(__file__).parent.parent / ".env"):
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env.setdefault(key.strip(), value.strip())
    for key in REQUIRED_KEYS:
        if not env.get(key) and os.environ.get(key):
            env[key] = os.environ[key]
    missing = [k for k in REQUIRED_KEYS if not env.get(k)]
    if missing:
        sys.exit(f"missing {', '.join(missing)} — set .env or export them")
    return env


def derive_flag(value: float | None, ref_low: float | None, ref_high: float | None) -> str | None:
    """Range comparison, and ONLY when the comparison is actually defined.

    Returns None rather than guessing when the value or both bounds are absent —
    a marker whose reference range the report stated only as prose ("desirable
    value", multi-tier vitamin D bands) keeps ref_text and no flag, so the
    UI shows the printed range instead of inventing a verdict. A report that
    flags a result itself without a parseable direction is transcribed as
    'abnormal' in the JSON and passes through untouched.
    """
    if value is None:
        return None
    if ref_low is None and ref_high is None:
        return None
    if ref_low is not None and value < ref_low:
        return "low"
    if ref_high is not None and value > ref_high:
        return "high"
    return "normal"


def normalize_marker(raw: dict, index: int) -> dict:
    code = (raw.get("code") or "").strip()
    label = (raw.get("label_raw") or "").strip()
    if not code or not label:
        sys.exit(f"marker #{index}: both 'code' and 'label_raw' are required — got {raw!r}")

    value_num = raw.get("value_num")
    ref_low = raw.get("ref_low")
    ref_high = raw.get("ref_high")
    # An explicitly transcribed flag wins: it records what the REPORT said, which
    # outranks our arithmetic (a lab flags against its own internal criteria).
    flag = raw.get("flag") or derive_flag(value_num, ref_low, ref_high)
    if flag is not None and flag not in VALID_FLAGS:
        sys.exit(f"marker '{code}': flag must be one of {VALID_FLAGS}, got {flag!r}")

    return {
        "code": code,
        "label_raw": label,
        "category": raw.get("category"),
        "value_num": value_num,
        "value_text": raw.get("value_text"),
        "unit": raw.get("unit"),
        "ref_low": ref_low,
        "ref_high": ref_high,
        "ref_text": raw.get("ref_text"),
        "flag": flag,
        "method": raw.get("method"),
        "position": index,
    }


def load_panel(path: pathlib.Path) -> tuple[dict, list[dict]]:
    doc = json.loads(path.read_text())
    for field in ("collected_on", "panel_name"):
        if not doc.get(field):
            sys.exit(f"{path.name}: '{field}' is required")

    panel = {
        "collected_on": doc["collected_on"],
        "lab": doc.get("lab"),
        "panel_name": doc["panel_name"],
        "source_file": doc.get("source_file"),
        "notes": doc.get("notes"),
    }
    markers = [normalize_marker(m, i) for i, m in enumerate(doc.get("markers") or [])]
    if not markers:
        sys.exit(f"{path.name}: no markers to import")

    seen: set[str] = set()
    for m in markers:
        if m["code"] in seen:
            sys.exit(f"{path.name}: duplicate marker code '{m['code']}'")
        seen.add(m["code"])
    return panel, markers


def request(env: dict, method: str, path: str, body=None, params: str = "", prefer: str = ""):
    url = f"{env['SUPABASE_URL']}/rest/v1/{path}"
    if params:
        url += f"?{params}"
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
            text = resp.read().decode()
            return json.loads(text) if text.strip() else []
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:400]}")


def print_table(panel: dict, markers: list[dict]) -> None:
    print(f"\n{panel['panel_name']}  ·  {panel['collected_on']}  ·  {panel.get('lab') or '—'}")
    print(f"source: {panel.get('source_file') or '—'}\n")
    width = max(len(m["label_raw"]) for m in markers)
    for m in markers:
        value = m["value_text"] or (
            f"{m['value_num']:g}" if m["value_num"] is not None else "—"
        )
        mark = {"low": " LOW", "high": " HIGH", "abnormal": " **"}.get(m["flag"] or "", "")
        ref = m["ref_text"] or ""
        print(f"  {m['label_raw']:<{width}}  {value:>10} {m.get('unit') or '':<10} {ref}{mark}")
    flagged = [m for m in markers if m["flag"] in ("low", "high", "abnormal")]
    print(f"\n  {len(markers)} markers, {len(flagged)} outside range")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=pathlib.Path)
    ap.add_argument("--dry-run", action="store_true", help="print what would be written, write nothing")
    args = ap.parse_args()

    panel, markers = load_panel(args.file)
    print_table(panel, markers)
    if args.dry_run:
        print("\n(dry run — nothing written)")
        return

    env = load_env()
    # Idempotent on (collected_on, panel_name), so a corrected transcription can
    # simply be re-imported: the panel upserts and its markers are replaced
    # wholesale rather than accumulating duplicates.
    rows = request(
        env,
        "POST",
        "blood_panels",
        body=[panel],
        params="on_conflict=collected_on,panel_name",
        prefer="resolution=merge-duplicates,return=representation",
    )
    panel_id = rows[0]["id"]
    request(env, "DELETE", "blood_markers", params=f"panel_id=eq.{panel_id}")
    request(
        env,
        "POST",
        "blood_markers",
        body=[{**m, "panel_id": panel_id} for m in markers],
        prefer="return=minimal",
    )
    print(f"\nimported {len(markers)} markers into panel {panel_id}")


if __name__ == "__main__":
    main()
