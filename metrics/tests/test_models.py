"""Formula tests — fixtures derived directly from SPEC §5. These define the
contract; models.py implements exactly this."""

import math

import pytest

from metrics.models import (
    acwr,
    classify_zone,
    ctl_atl_series,
    ef,
    ef_eligibility,
    flags_for_day,
    hr_drift_pct,
    time_in_zones,
    trimp_edwards,
    zone_bounds,
)

# hr_max=190, rhr=60 -> HRR=130. Karvonen bounds: Z2 starts 60+0.60*130=138,
# Z3 151, Z4 164, Z5 177.
BOUNDS = zone_bounds(hr_max=190, rhr_recent=60, z2_low=0.60, z2_high=0.70)


def test_zone_bounds_karvonen():
    assert BOUNDS == (138.0, 151.0, 164.0, 177.0)


def test_classify_zones():
    assert classify_zone(120, BOUNDS) == 1
    assert classify_zone(138, BOUNDS) == 2  # boundary belongs to the higher zone
    assert classify_zone(150, BOUNDS) == 2
    assert classify_zone(151, BOUNDS) == 3
    assert classify_zone(170, BOUNDS) == 4
    assert classify_zone(177, BOUNDS) == 5
    assert classify_zone(185, BOUNDS) == 5


def test_time_in_zones_spacing_is_gap_to_next_capped_30s():
    # 10s spacing; last sample contributes nothing (no next sample).
    samples = [(0, 120), (10, 120), (20, 140), (30, 140)]
    tiz = time_in_zones(samples, BOUNDS)
    assert tiz == {1: 20, 2: 10, 3: 0, 4: 0, 5: 0}

    # 120s gap capped at 30.
    samples = [(0, 120), (120, 120), (130, 120)]
    tiz = time_in_zones(samples, BOUNDS)
    assert tiz == {1: 40, 2: 0, 3: 0, 4: 0, 5: 0}


def test_time_in_zones_swim_offset_shifts_samples_up():
    # swim_hr_offset = -10: subtracting it adds 10 bpm, i.e. bounds shift down.
    # 130 bpm raw -> 140 adjusted -> Z2.
    samples = [(0, 130), (10, 130)]
    assert time_in_zones(samples, BOUNDS)[1] == 10
    tiz = time_in_zones(samples, BOUNDS, swim_hr_offset=-10)
    assert tiz[2] == 10


def test_trimp_edwards_minutes_times_zone_number():
    tiz = {1: 600, 2: 300, 3: 60, 4: 0, 5: 0}  # seconds
    # 10min*1 + 5min*2 + 1min*3 = 23
    assert trimp_edwards(tiz) == pytest.approx(23.0)


def test_ef_formula():
    # (1400 m / 30 min) / 120 bpm
    assert ef(1400, 1800, 120) == pytest.approx((1400 / 30) / 120)
    assert ef(None, 1800, 120) is None
    assert ef(1400, 1800, None) is None
    assert ef(1400, 0, 120) is None


def test_ef_eligibility_swims_z1z2_70pct_20min():
    tiz_ok = {1: 900, 2: 300, 3: 300, 4: 0, 5: 0}  # 80% z1-z2, 25 min
    assert ef_eligibility("pool_swim", tiz_ok, 1500)
    assert not ef_eligibility("indoor_cycling", tiz_ok, 1500)  # swims only
    assert not ef_eligibility("pool_swim", tiz_ok, 1100)  # <20 min
    tiz_hot = {1: 300, 2: 300, 3: 900, 4: 0, 5: 0}  # 40% z1-z2
    assert not ef_eligibility("pool_swim", tiz_hot, 1500)


def test_hr_drift_pct_half_split():
    # first half avg 110, second half avg 121 -> +10%
    samples = [(i * 10, 110) for i in range(6)] + [(60 + i * 10, 121) for i in range(6)]
    assert hr_drift_pct(samples) == pytest.approx(10.0)
    assert hr_drift_pct([(0, 110)]) is None  # too few samples


def test_ctl_atl_ewma():
    # CTL_t = CTL_{t-1} + (TRIMP_t - CTL_{t-1})/42, seeded at 0.
    trimps = [42.0, 42.0]
    series = ctl_atl_series(trimps)
    ctl, atl = series[0]
    assert ctl == pytest.approx(1.0)
    assert atl == pytest.approx(6.0)
    ctl2, _ = series[1]
    assert ctl2 == pytest.approx(1.0 + (42.0 - 1.0) / 42)
    # constant load converges to the load
    series = ctl_atl_series([42.0] * 2000)
    assert series[-1][0] == pytest.approx(42.0, abs=0.01)
    assert series[-1][1] == pytest.approx(42.0, abs=0.01)


def test_acwr_null_under_21_days_and_ratio():
    assert acwr([10.0] * 20, 19) is None  # <21 days of history
    assert acwr([10.0] * 28, 27) == pytest.approx(1.0)
    # denominator ~ 0 -> None
    assert acwr([0.0] * 28, 27) is None
    # last 7 days doubled vs steady 28d history
    hist = [10.0] * 21 + [20.0] * 7
    assert acwr(hist, 27) == pytest.approx(20.0 / (mean := (21 * 10 + 7 * 20) / 28))
    assert acwr(hist, 27) == pytest.approx(20.0 / mean)


def test_flags_acwr_high():
    flags = flags_for_day(acwr_value=1.6, rhr_dev_last3=[1.0, 2.0, 1.0], week_missed=False)
    assert len(flags) == 1
    f = flags[0]
    assert f["type"] == "acwr_high"
    assert "1.6" in f["message"]
    assert f["severity"] == "warn"


def test_flags_rhr_elevated_needs_3_consecutive_days():
    assert flags_for_day(None, [4.0, 5.0, 4.5], False)[0]["type"] == "rhr_elevated"
    assert flags_for_day(None, [4.0, 5.0, 4.5], False)[0]["severity"] == "warn"
    assert flags_for_day(None, [4.0, 3.0, 4.5], False) == []  # broken run
    assert flags_for_day(None, [5.0, 4.0], False) == []  # only 2 days


def test_flags_week_minimum_missed_is_info():
    flags = flags_for_day(None, [0, 0, 0], True)
    assert flags == [
        {
            "type": "week_minimum_missed",
            "message": flags[0]["message"],
            "severity": "info",
        }
    ]
    assert "minimum" in flags[0]["message"].lower() or "week" in flags[0]["message"].lower()


def test_flags_never_use_alarm_severity_for_missed_week():
    for f in flags_for_day(1.8, [5, 5, 5], True):
        if f["type"] == "week_minimum_missed":
            assert f["severity"] == "info"
