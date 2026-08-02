"""Nightly config parsing must distinguish an explicit zero from NULL."""

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
