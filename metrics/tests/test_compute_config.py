"""Nightly configuration and initialization boundary regressions."""

from metrics import compute, db
from metrics.compute import configured_float


def test_configured_float_preserves_zero():
    config = {
        "swim_hr_offset": 0,
        "zone2_low_frac": 0,
        "zone2_high_frac": 0.7,
    }

    assert configured_float(config, "swim_hr_offset", -10) == 0.0
    assert configured_float(config, "zone2_low_frac", 0.6) == 0.0
    assert configured_float(config, "zone2_high_frac", 0.7) == 0.7


def test_configured_float_defaults_only_for_missing_or_null():
    assert configured_float({}, "swim_hr_offset", -10) == -10.0
    assert configured_float({"swim_hr_offset": None}, "swim_hr_offset", -10) == -10.0


def test_run_defers_when_neither_config_nor_workouts_have_valid_hr_max(monkeypatch, capsys):
    monkeypatch.setattr(db, "client", lambda: None)
    monkeypatch.setattr(
        db,
        "fetch_user_config",
        lambda sb: {"timezone": "UTC", "hr_max": None},
    )
    monkeypatch.setattr(db, "fetch_daily_metrics", lambda sb: [])
    monkeypatch.setattr(
        db,
        "fetch_workouts",
        lambda sb, since: [
            {
                "id": "hr-missing",
                "type": "running",
                "start_at": "2026-08-01T10:00:00Z",
                "duration_s": 1800,
                "distance_m": 5000,
                "avg_hr": None,
                "max_hr": None,
            }
        ],
    )
    monkeypatch.setattr(
        db,
        "update_hr_max",
        lambda sb, value: (_ for _ in ()).throw(AssertionError(f"invalid hr_max write: {value}")),
    )

    compute.run(full=False)

    assert "no valid hr_max" in capsys.readouterr().out
