"""Goal progress normalization: goal_progress_rows turns agent-authored
metric_sql's raw exec_readonly_sql output into upsert-ready rows, tolerating
schema drift (missing/unparseable date or value) without failing the goal."""

from metrics.compute import goal_progress_rows


def test_valid_rows_pass_through_rounded():
    result = [{"date": "2026-07-01", "value": 42.123456}]
    assert goal_progress_rows("g1", result) == [
        {"goal_id": "g1", "date": "2026-07-01", "value": 42.1235}
    ]


def test_iso_timestamp_dates_truncate_to_date():
    result = [{"date": "2026-07-01T14:30:00Z", "value": 5}]
    rows = goal_progress_rows("g1", result)
    assert rows == [{"goal_id": "g1", "date": "2026-07-01", "value": 5.0}]


def test_iso_timestamp_with_offset_truncates_to_date():
    result = [{"date": "2026-07-01T23:00:00+02:00", "value": 1}]
    rows = goal_progress_rows("g1", result)
    assert rows[0]["date"] == "2026-07-01"


def test_numeric_strings_coerced_to_float():
    result = [{"date": "2026-07-01", "value": "12.5"}]
    assert goal_progress_rows("g1", result) == [
        {"goal_id": "g1", "date": "2026-07-01", "value": 12.5}
    ]


def test_null_value_skipped():
    result = [{"date": "2026-07-01", "value": None}]
    assert goal_progress_rows("g1", result) == []


def test_nan_value_skipped():
    result = [{"date": "2026-07-01", "value": float("nan")}]
    assert goal_progress_rows("g1", result) == []


def test_missing_date_skipped():
    result = [{"value": 3}]
    assert goal_progress_rows("g1", result) == []


def test_unparseable_date_skipped():
    result = [{"date": "not-a-date", "value": 3}]
    assert goal_progress_rows("g1", result) == []


def test_unparseable_value_skipped():
    result = [{"date": "2026-07-01", "value": "not-a-number"}]
    assert goal_progress_rows("g1", result) == []


def test_dedupe_on_date_keeps_last_occurrence():
    result = [
        {"date": "2026-07-01", "value": 1},
        {"date": "2026-07-01", "value": 99},
    ]
    assert goal_progress_rows("g1", result) == [
        {"goal_id": "g1", "date": "2026-07-01", "value": 99.0}
    ]


def test_sorted_by_date():
    result = [
        {"date": "2026-07-03", "value": 3},
        {"date": "2026-07-01", "value": 1},
        {"date": "2026-07-02", "value": 2},
    ]
    rows = goal_progress_rows("g1", result)
    assert [r["date"] for r in rows] == ["2026-07-01", "2026-07-02", "2026-07-03"]


def test_mixed_valid_and_invalid_rows():
    result = [
        {"date": "2026-07-01", "value": 1},
        {"date": None, "value": 2},
        {"date": "2026-07-02", "value": None},
        {"date": "bad", "value": 3},
        {"date": "2026-07-03", "value": "bad"},
        {"date": "2026-07-04", "value": 4},
    ]
    rows = goal_progress_rows("g1", result)
    assert [r["date"] for r in rows] == ["2026-07-01", "2026-07-04"]
