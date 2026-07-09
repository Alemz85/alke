"""Pure metric formulas per SPEC §5. No I/O — everything here is a function of
its inputs so the test suite pins the math exactly."""

from __future__ import annotations

from statistics import median

Sample = tuple[int, float]  # (offset_s, bpm)
SPACING_CAP_S = 30
ACWR_FLAG_THRESHOLD = 1.5
RHR_FLAG_DEV_BPM = 4.0
RHR_FLAG_RUN_DAYS = 3


def zone_bounds(
    hr_max: float, rhr_recent: float, z2_low: float = 0.60, z2_high: float = 0.70
) -> tuple[float, float, float, float]:
    """Karvonen: thresholds where Z2..Z5 begin. Z3/Z4 bounds continue in 0.10
    steps above the configurable Z2 band."""
    hrr = hr_max - rhr_recent
    return (
        rhr_recent + z2_low * hrr,
        rhr_recent + z2_high * hrr,
        rhr_recent + (z2_high + 0.10) * hrr,
        rhr_recent + (z2_high + 0.20) * hrr,
    )


def classify_zone(bpm: float, bounds: tuple[float, float, float, float]) -> int:
    for zone, threshold in enumerate(bounds, start=2):
        if bpm < threshold:
            return zone - 1
    return 5


def time_in_zones(
    samples: list[Sample],
    bounds: tuple[float, float, float, float],
    swim_hr_offset: float = 0.0,
) -> dict[int, int]:
    """Seconds per zone. Sample duration = gap to next sample capped at 30s;
    the last sample has no next and contributes nothing. Swims: subtracting the
    (negative) offset shifts samples up, i.e. zone bounds effectively down."""
    tiz = {z: 0 for z in range(1, 6)}
    ordered = sorted(samples)
    for (offset, bpm), (next_offset, _) in zip(ordered, ordered[1:]):
        duration = min(next_offset - offset, SPACING_CAP_S)
        zone = classify_zone(bpm - swim_hr_offset, bounds)
        tiz[zone] += duration
    return tiz


def trimp_edwards(tiz: dict[int, int]) -> float:
    return sum(seconds / 60.0 * zone for zone, seconds in tiz.items())


def ef(distance_m: float | None, duration_s: float | None, avg_hr: float | None) -> float | None:
    if not distance_m or not duration_s or not avg_hr:
        return None
    return (distance_m / (duration_s / 60.0)) / avg_hr


def ef_eligibility(workout_type: str | None, tiz: dict[int, int], duration_s: float | None) -> bool:
    """EF/decoupling are swim-only, ≥20 min, ≥70% of classified time in Z1–Z2."""
    if not workout_type or "swim" not in workout_type.lower():
        return False
    if not duration_s or duration_s < 20 * 60:
        return False
    total = sum(tiz.values())
    if total == 0:
        return False
    return (tiz[1] + tiz[2]) / total >= 0.70


def hr_drift_pct(samples: list[Sample]) -> float | None:
    """HR-only drift: (avgHR second half − avgHR first half) / first half × 100.
    Positive = drifting up = decoupling. Used because only total distance is
    stored (no per-sample distance), per SPEC §5.2's fallback."""
    if len(samples) < 4:
        return None
    ordered = sorted(samples)
    midpoint = (ordered[0][0] + ordered[-1][0]) / 2
    first = [bpm for off, bpm in ordered if off <= midpoint]
    second = [bpm for off, bpm in ordered if off > midpoint]
    if not first or not second:
        return None
    avg1 = sum(first) / len(first)
    avg2 = sum(second) / len(second)
    if avg1 == 0:
        return None
    return (avg2 - avg1) / avg1 * 100.0


def hrr60(samples: list[Sample], duration_s: float | None) -> float | None:
    """Max HR in the final 2 min minus HR ~60s after the end, when post-end
    samples exist in the stream. Health Auto Export rarely provides them."""
    if not samples or not duration_s:
        return None
    ordered = sorted(samples)
    final_window = [bpm for off, bpm in ordered if duration_s - 120 <= off <= duration_s]
    post = [(abs(off - (duration_s + 60)), bpm) for off, bpm in ordered if off >= duration_s + 45]
    if not final_window or not post:
        return None
    return max(final_window) - min(post)[1]


def ctl_atl_series(daily_trimp: list[float]) -> list[tuple[float, float]]:
    """EWMA chains seeded at 0: X_t = X_{t-1} + (TRIMP_t − X_{t-1}) / tc."""
    out: list[tuple[float, float]] = []
    ctl = atl = 0.0
    for t in daily_trimp:
        ctl += (t - ctl) / 42.0
        atl += (t - atl) / 7.0
        out.append((ctl, atl))
    return out


def acwr(daily_trimp: list[float], idx: int) -> float | None:
    """Mean TRIMP last 7 days ÷ mean last 28 days at day `idx`. None when
    history < 21 days or the chronic denominator is ~0."""
    if idx + 1 < 21:
        return None
    acute = daily_trimp[max(0, idx - 6) : idx + 1]
    chronic = daily_trimp[max(0, idx - 27) : idx + 1]
    chronic_mean = sum(chronic) / len(chronic)
    if chronic_mean < 1e-9:
        return None
    return (sum(acute) / len(acute)) / chronic_mean


def rolling_median(values: list[float]) -> float | None:
    cleaned = [v for v in values if v is not None]
    return median(cleaned) if cleaned else None


def flags_for_day(
    acwr_value: float | None,
    rhr_dev_last3: list[float | None],
    week_missed: bool,
) -> list[dict]:
    """The only three defined flag types (SPEC §5.3)."""
    flags: list[dict] = []
    if acwr_value is not None and acwr_value > ACWR_FLAG_THRESHOLD:
        flags.append(
            {
                "type": "acwr_high",
                "message": (
                    f"Ramp rate high: last 7 days = {acwr_value:.1f}× your 28-day average. "
                    "Rapid ramps raise overuse-injury risk — consider holding volume this week."
                ),
                "severity": "warn",
            }
        )
    devs = [d for d in rhr_dev_last3 if d is not None]
    if len(devs) >= RHR_FLAG_RUN_DAYS and all(d >= RHR_FLAG_DEV_BPM for d in devs[-RHR_FLAG_RUN_DAYS:]):
        flags.append(
            {
                "type": "rhr_elevated",
                "message": (
                    f"Resting HR +{devs[-1]:.0f} bpm above baseline for "
                    f"{RHR_FLAG_RUN_DAYS} days — consider an easy day and watch sleep."
                ),
                "severity": "warn",
            }
        )
    if week_missed:
        flags.append(
            {
                "type": "week_minimum_missed",
                "message": "Last week finished under your weekly session minimums.",
                "severity": "info",
            }
        )
    return flags
