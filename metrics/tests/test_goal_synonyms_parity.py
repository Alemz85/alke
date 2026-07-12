"""Parity pin: GOAL_SYNONYMS in compute.py mirrors the desktop app's modality
matcher (app/src/renderer/src/lib/modality.ts). The two live in different
languages and drift silently — this test parses the TS literal and fails the
suite when the maps diverge, naming the direction of the drift."""

import re
from pathlib import Path

from metrics.compute import GOAL_SYNONYMS

MODALITY_TS = (
    Path(__file__).resolve().parents[2] / "app" / "src" / "renderer" / "src" / "lib" / "modality.ts"
)


def ts_goal_synonyms() -> dict[str, list[str]]:
    source = MODALITY_TS.read_text()
    match = re.search(
        r"const GOAL_SYNONYMS[^=]*=\s*\{(.*?)\n\}", source, re.DOTALL
    )
    assert match, f"GOAL_SYNONYMS literal not found in {MODALITY_TS}"
    entries = re.findall(r"(\w+):\s*\[([^\]]*)\]", match.group(1))
    assert entries, "GOAL_SYNONYMS literal parsed to zero entries"
    return {
        key: re.findall(r"'([^']*)'", values) for key, values in entries
    }


def test_goal_synonyms_match_app_modality_matcher():
    ts_map = ts_goal_synonyms()
    assert GOAL_SYNONYMS == ts_map, (
        "GOAL_SYNONYMS drift between metrics/compute.py and "
        "app/src/renderer/src/lib/modality.ts — update both sides together.\n"
        f"python: {GOAL_SYNONYMS}\nts:     {ts_map}"
    )
