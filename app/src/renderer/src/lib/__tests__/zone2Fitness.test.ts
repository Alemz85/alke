import { describe, expect, it } from 'vitest'
import type { Zone2Fitness } from '@shared/types'
import { ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING } from '@shared/types'
import {
  durableBandCaption,
  durableBandHalfWidth,
  evidenceReason,
  formatGuidanceDate,
  hasMaintenanceFlag,
  indexBandHalfWidth,
  latestZone2Row,
  maintenanceMessage,
  stageLabel,
  zone2BarGeometry,
  zone2CalendarGuidance,
  zone2IndexValue
} from '../zone2Fitness'

const C_D = ZONE2_DURABLE_CEILING // 70
const C_F = ZONE2_FAST_CEILING // 30

// Minimal row factory — only the fields under test carry meaning; the rest are nulled.
// NOTE: anchor_beta was removed from the shared Zone2Fitness type (v3 amendment) —
// deliberately absent here. maintain_horizon_days / build_interval_days /
// expected_session_build are the new v3 horizon columns.
function row(overrides: Partial<Zone2Fitness>): Zone2Fitness {
  return {
    date: '2026-07-10',
    durable_base: null,
    durable_band_lo: null,
    durable_band_hi: null,
    sharpness: null,
    vo2max_anchor_score: null,
    days_since_vo2max: null,
    durable_load: null,
    sharp_load: null,
    base_accum_b: null,
    tau_slow_days: null,
    floor_score: null,
    confidence: null,
    evidence_state: 'ok',
    contributing: null,
    stage: 'literature',
    maintenance_met: null,
    warn_after_days: null,
    maintain_horizon_days: null,
    build_interval_days: null,
    expected_session_build: null,
    flags: [],
    computed_at: null,
    ...overrides
  }
}

describe('latestZone2Row', () => {
  it('returns null for an empty array', () => {
    expect(latestZone2Row([])).toBeNull()
  })

  it('picks the row with the greatest date regardless of input order', () => {
    const rows = [
      row({ date: '2026-07-01', durable_base: 10 }),
      row({ date: '2026-07-10', durable_base: 40 }),
      row({ date: '2026-07-05', durable_base: 25 })
    ]
    expect(latestZone2Row(rows)?.durable_base).toBe(40)
  })

  it('breaks a same-date tie by computed_at', () => {
    const rows = [
      row({ date: '2026-07-10', durable_base: 30, computed_at: '2026-07-10T03:00:00Z' }),
      row({ date: '2026-07-10', durable_base: 42, computed_at: '2026-07-10T04:00:00Z' })
    ]
    expect(latestZone2Row(rows)?.durable_base).toBe(42)
  })
})

describe('durableBandHalfWidth', () => {
  it('halves the lo→hi span and rounds', () => {
    expect(durableBandHalfWidth(row({ durable_band_lo: 34, durable_band_hi: 46 }))).toBe(6)
    expect(durableBandHalfWidth(row({ durable_band_lo: 33, durable_band_hi: 44 }))).toBe(6) // 5.5 → 6
  })

  it('returns null when either bound is missing', () => {
    expect(durableBandHalfWidth(row({ durable_band_lo: 30, durable_band_hi: null }))).toBeNull()
    expect(durableBandHalfWidth(row({ durable_band_lo: null, durable_band_hi: 40 }))).toBeNull()
  })

  it('never returns a negative width — an inverted band is order-insensitive (abs), matching indexBandHalfWidth', () => {
    // Unified band-half-width helper (bandHalfWidth): abs(hi-lo)/2, never negative,
    // never silently zeroed. durable_band_lo/hi ARE the index band columns (v2), so
    // durableBandHalfWidth and indexBandHalfWidth must agree on every input, including
    // an inverted one — they previously disagreed here (0 vs 5).
    expect(durableBandHalfWidth(row({ durable_band_lo: 50, durable_band_hi: 40 }))).toBe(5)
    expect(durableBandHalfWidth(row({ durable_band_lo: 50, durable_band_hi: 40 }))).toBe(
      indexBandHalfWidth(row({ durable_band_lo: 50, durable_band_hi: 40 }))
    )
  })
})

describe('stageLabel', () => {
  it('labels each stage', () => {
    expect(stageLabel('literature')).toBe('Literature estimate')
    expect(stageLabel('lightly_tuned', 3)).toBe('Lightly tuned (3 episodes)')
    expect(stageLabel('lightly_tuned', 1)).toBe('Lightly tuned (1 episode)')
    expect(stageLabel('lightly_tuned')).toBe('Lightly tuned')
    expect(stageLabel('personalized')).toBe('Personalized')
  })
})

describe('durableBandCaption', () => {
  it('combines band and stage', () => {
    expect(durableBandCaption(row({ durable_band_lo: 34, durable_band_hi: 46, stage: 'literature' }))).toBe(
      '±6 · Literature estimate'
    )
  })

  it('falls back to stage only when band is unknown', () => {
    expect(durableBandCaption(row({ stage: 'personalized' }))).toBe('Personalized')
  })
})

describe('hasMaintenanceFlag / maintenanceMessage', () => {
  it('detects a zone2_maintenance flag', () => {
    const r = row({ flags: [{ type: 'zone2_maintenance', severity: 'info', message: 'below the dose' }] })
    expect(hasMaintenanceFlag(r)).toBe(true)
    expect(maintenanceMessage(r)).toBe('below the dose')
  })

  it('ignores unrelated flags', () => {
    const r = row({ flags: [{ type: 'acwr_high', message: 'ramp' }] })
    expect(hasMaintenanceFlag(r)).toBe(false)
    expect(maintenanceMessage(r)).toBeNull()
  })

  it('is safe for null / empty rows', () => {
    expect(hasMaintenanceFlag(null)).toBe(false)
    expect(hasMaintenanceFlag(row({ flags: [] }))).toBe(false)
    expect(maintenanceMessage(null)).toBeNull()
  })
})

describe('evidenceReason', () => {
  it('returns null for ok, a reason otherwise', () => {
    expect(evidenceReason('ok')).toBeNull()
    expect(evidenceReason('insufficient')).toContain('valid sensor days')
    expect(evidenceReason('ambiguous')).toContain('disagree')
    expect(evidenceReason('low_confidence')).toContain('VO2max')
  })
})

describe('formatGuidanceDate', () => {
  it('formats a date key as "Wkd D Mon" with the correct weekday', () => {
    expect(formatGuidanceDate('2026-07-10')).toBe('Fri 10 Jul') // 2026-07-10 is a Friday
    expect(formatGuidanceDate('2026-07-11')).toBe('Sat 11 Jul')
    expect(formatGuidanceDate('2026-01-01')).toBe('Thu 1 Jan')
  })
})

describe('zone2CalendarGuidance', () => {
  const TODAY = '2026-07-10' // Friday

  it('anchors every marker at the ROW DATE (not the last session), adding each stored horizon', () => {
    // Row dated 07-08; last session on record is 07-01 (a week earlier — the row's
    // own state already embeds that gap, so re-anchoring at 07-01 would double count it).
    const g = zone2CalendarGuidance(
      {
        date: '2026-07-08',
        warn_after_days: 14,
        maintain_horizon_days: 6,
        build_interval_days: 2
      },
      ['2026-07-01'],
      TODAY
    )
    expect(g.lastSession).toBe('2026-07-01') // kept for copy only
    // decayFrom = rowDate(07-08) + 14 = 07-22.
    expect(g.decayFrom).toBe('2026-07-22')
    // maintainBy = rowDate(07-08) + 6 = 07-14.
    expect(g.maintainBy).toBe('2026-07-14')
    // buildBy = rowDate(07-08) + 2 = 07-10 (today — still valid, not in the past).
    expect(g.buildBy).toBe('2026-07-10')
    expect(g.markers[g.buildBy!].kind).toBe('build')
    expect(g.markers[g.maintainBy!].kind).toBe('maintain')
    expect(g.markers[g.decayFrom!].kind).toBe('decay')
    expect(g.alreadyEasing).toBe(false)
  })

  it('keeps fractional horizons intact until the single date-key rounding point', () => {
    // 4.6 days from 07-08 rounds to +5d = 07-13; 3.4 days rounds to +3d = 07-11
    // (addDaysKey rounds once, at materialization — not before).
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 20, maintain_horizon_days: 4.6, build_interval_days: 3.4 },
      [],
      TODAY
    )
    expect(g.maintainBy).toBe('2026-07-13') // 07-08 + round(4.6) = +5d
    expect(g.buildBy).toBe('2026-07-11') // 07-08 + round(3.4) = +3d
  })

  it('clamps a marker whose raw horizon lands before today to display on today', () => {
    // build_interval_days = 1.2 from row date 07-08 raw-computes to 07-09, which
    // is before TODAY (07-10) — display clamps to today rather than the past date.
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 20, maintain_horizon_days: 4.6, build_interval_days: 1.2 },
      [],
      TODAY
    )
    expect(g.buildBy).toBe(TODAY)
  })

  it('treats warn_after_days = 0 as valid "already easing" data, not missing data', () => {
    // Row date is today; decay horizon is 0 → decays as of today itself.
    const g = zone2CalendarGuidance(
      { date: TODAY, warn_after_days: 0, maintain_horizon_days: null, build_interval_days: null },
      [],
      TODAY
    )
    expect(g.decayFrom).toBe(TODAY)
    expect(g.alreadyEasing).toBe(true)
    expect(g.markers[TODAY].kind).toBe('decay')
    expect(g.markers[TODAY].label).toMatch(/easing now/i)
    expect(g.summary).toMatch(/easing now/i)
  })

  it('treats a decayFrom that lands before today as overdue — clamped display, honest copy', () => {
    // Row is 20 days stale; warn_after_days=5 means the model's own horizon is
    // long past — the raw date is well before today.
    const g = zone2CalendarGuidance(
      { date: '2026-06-20', warn_after_days: 5, maintain_horizon_days: null, build_interval_days: null },
      [],
      TODAY
    )
    // Raw decayFrom (06-25) is before today; display clamps to today, never a fake future date.
    expect(g.decayFrom).toBe(TODAY)
    expect(g.alreadyEasing).toBe(true)
    expect(g.markers[TODAY].label).toMatch(/already past its hold window/i)
  })

  it('omits a marker entirely when its horizon column is null (old pre-migration rows)', () => {
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 12, maintain_horizon_days: null, build_interval_days: null },
      [],
      TODAY
    )
    expect(g.decayFrom).toBe('2026-07-20')
    expect(g.maintainBy).toBeNull()
    expect(g.buildBy).toBeNull()
    expect(g.doses.build).toBeNull()
    // No maintain/build entries in the marker record — only decay.
    expect(Object.values(g.markers).map((m) => m.kind).sort()).toEqual(['decay'])
    expect(g.summary).not.toMatch(/keep building/i)
    expect(g.summary).not.toMatch(/holds through/i)
  })

  it('returns an all-null, marker-free guidance when the row itself is missing', () => {
    const g = zone2CalendarGuidance(null, ['2026-07-08'], TODAY)
    expect(g.buildBy).toBeNull()
    expect(g.maintainBy).toBeNull()
    expect(g.decayFrom).toBeNull()
    expect(g.markers).toEqual({})
    expect(g.doses.build).toBeNull()
    // lastSession/sessions7d still computed from session history (copy only).
    expect(g.lastSession).toBe('2026-07-08')
  })

  it('resolves a same-day collision with priority build > maintain > decay', () => {
    // All three horizons land on the same day (07-15) from the same row date.
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 7, maintain_horizon_days: 7, build_interval_days: 7 },
      [],
      TODAY
    )
    expect(g.buildBy).toBe('2026-07-15')
    expect(g.maintainBy).toBe('2026-07-15')
    expect(g.decayFrom).toBe('2026-07-15')
    // Only one marker survives the collision, and it's the most actionable kind.
    expect(Object.keys(g.markers)).toEqual(['2026-07-15'])
    expect(g.markers['2026-07-15'].kind).toBe('build')
  })

  it('resolves a maintain/decay collision (no build) with maintain winning over decay', () => {
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 6, maintain_horizon_days: 6, build_interval_days: null },
      [],
      TODAY
    )
    expect(g.maintainBy).toBe('2026-07-14')
    expect(g.decayFrom).toBe('2026-07-14')
    expect(Object.keys(g.markers)).toEqual(['2026-07-14'])
    expect(g.markers['2026-07-14'].kind).toBe('maintain')
  })

  it('counts sessions in the trailing 7 days and ignores future-dated rows (copy only)', () => {
    // 07-04..07-10 inclusive is the window; 07-03 is out, 07-11 is future.
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 14, maintain_horizon_days: 6, build_interval_days: 3 },
      ['2026-07-03', '2026-07-04', '2026-07-08', '2026-07-10', '2026-07-11'],
      TODAY
    )
    expect(g.sessions7d).toBe(3) // 07-04, 07-08, 07-10
    // A future-dated session is clamped to today, so lastSession never exceeds today.
    expect(g.lastSession).toBe('2026-07-10')
    // None of this affects the anchor — still the row date.
    expect(g.decayFrom).toBe('2026-07-22')
  })

  it('derives the build dose frequency from build_interval_days, not a hardcoded dose', () => {
    const everyTwo = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 20, maintain_horizon_days: 10, build_interval_days: 2 },
      [],
      TODAY
    )
    expect(everyTwo.doses.build).toContain('every ~2 days')
    expect(everyTwo.doses.build).toMatch(/≈3\.5\/wk/)
    expect(everyTwo.doses.build).toContain('at Zone 2 intensity')
    expect(everyTwo.doses.build).not.toContain('40–50 min')

    const everyFive = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 20, maintain_horizon_days: 10, build_interval_days: 5 },
      [],
      TODAY
    )
    expect(everyFive.doses.build).toContain('every ~5 days')
    expect(everyFive.doses.build).toMatch(/≈1\.4\/wk/)
  })

  it('keeps the maintain dose as the licensed Hickson literature constant', () => {
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 14, maintain_horizon_days: 6, build_interval_days: 3 },
      [],
      TODAY
    )
    expect(g.doses.maintain).toContain('2 Zone 2 sessions/wk')
    expect(g.doses.maintain).toContain('≥20 min')
    expect(g.doses.maintain).toMatch(/already.built|base you.ve already built/i)
  })
})

describe('zone2IndexValue', () => {
  it('sums durable_base + sharpness (D + F)', () => {
    expect(zone2IndexValue(row({ durable_base: 42, sharpness: 18 }))).toBe(60)
  })

  it('treats a missing component as 0 when the other is present', () => {
    expect(zone2IndexValue(row({ durable_base: 40, sharpness: null }))).toBe(40)
    expect(zone2IndexValue(row({ durable_base: null, sharpness: 12 }))).toBe(12)
  })

  it('returns null only when BOTH components are missing', () => {
    expect(zone2IndexValue(row({ durable_base: null, sharpness: null }))).toBeNull()
  })
})

describe('indexBandHalfWidth', () => {
  it('halves the lo→hi span (index band) and rounds', () => {
    expect(indexBandHalfWidth(row({ durable_band_lo: 50, durable_band_hi: 62 }))).toBe(6)
    expect(indexBandHalfWidth(row({ durable_band_lo: 49, durable_band_hi: 60 }))).toBe(6) // 5.5 → 6
  })

  it('is order-insensitive (never negative even if columns are inverted)', () => {
    expect(indexBandHalfWidth(row({ durable_band_lo: 62, durable_band_hi: 50 }))).toBe(6)
  })

  it('returns null when either bound is missing', () => {
    expect(indexBandHalfWidth(row({ durable_band_lo: 50, durable_band_hi: null }))).toBeNull()
    expect(indexBandHalfWidth(row({ durable_band_lo: null, durable_band_hi: 60 }))).toBeNull()
  })
})

describe('zone2BarGeometry', () => {
  it('fills each zone to its component and ghosts the remaining headroom; slices tile the bar', () => {
    // D=35 of 70, F=15 of 30 → index 50. Total height 100.
    const g = zone2BarGeometry(row({ durable_base: 35, sharpness: 15 }), C_D, C_F)
    expect(g.indexValue).toBe(50)
    expect(g.durableFillPct).toBeCloseTo(35, 5) // 35/100
    expect(g.durableGhostPct).toBeCloseTo(35, 5) // (70-35)/100
    expect(g.fastFillPct).toBeCloseTo(15, 5) // 15/100
    expect(g.fastGhostPct).toBeCloseTo(15, 5) // (30-15)/100
    // The four slices always cover the whole bar.
    expect(g.durableFillPct + g.durableGhostPct + g.fastFillPct + g.fastGhostPct).toBeCloseTo(100, 5)
  })

  it('a thin durable base is a small solid block under a large ghost (honest headroom)', () => {
    const g = zone2BarGeometry(row({ durable_base: 7, sharpness: 0 }), C_D, C_F)
    expect(g.durableFillPct).toBeCloseTo(7, 5)
    expect(g.durableGhostPct).toBeCloseTo(63, 5) // 70-7
    expect(g.durableGhostPct).toBeGreaterThan(g.durableFillPct)
  })

  it('clamps a component that exceeds its ceiling (no fill spills past the zone)', () => {
    const g = zone2BarGeometry(row({ durable_base: 90, sharpness: 45 }), C_D, C_F)
    expect(g.durableFillPct).toBeCloseTo(70, 5) // clamped to C_D
    expect(g.durableGhostPct).toBeCloseTo(0, 5)
    expect(g.fastFillPct).toBeCloseTo(30, 5) // clamped to C_F
    expect(g.fastGhostPct).toBeCloseTo(0, 5)
    expect(g.indexValue).toBe(100) // clamped to total
  })

  it('treats null components as 0 (empty foundation, full ghost)', () => {
    const g = zone2BarGeometry(row({ durable_base: null, sharpness: null }), C_D, C_F)
    expect(g.durableFillPct).toBe(0)
    expect(g.fastFillPct).toBe(0)
    expect(g.durableGhostPct).toBeCloseTo(70, 5)
    expect(g.fastGhostPct).toBeCloseTo(30, 5)
    expect(g.indexValue).toBe(0)
  })

  it('maps the INDEX band to bar percentages, ordered and clamped', () => {
    const g = zone2BarGeometry(
      row({ durable_base: 40, sharpness: 10, durable_band_lo: 44, durable_band_hi: 56 }),
      C_D,
      C_F
    )
    expect(g.hasBand).toBe(true)
    expect(g.bandLoPct).toBeCloseTo(44, 5) // 44/100
    expect(g.bandHiPct).toBeCloseTo(56, 5) // 56/100
    expect(g.bandHiPct).toBeGreaterThan(g.bandLoPct)
  })

  it('collapses the band onto the index when a bound is missing', () => {
    const g = zone2BarGeometry(
      row({ durable_base: 40, sharpness: 10, durable_band_lo: 44, durable_band_hi: null }),
      C_D,
      C_F
    )
    expect(g.hasBand).toBe(false)
    // Both edges sit on the index (50) so the caller renders no error zone.
    expect(g.bandLoPct).toBeCloseTo(50, 5)
    expect(g.bandHiPct).toBeCloseTo(50, 5)
  })

  it('orders an INVERTED band (lo > hi in storage) so bandLoPct never exceeds bandHiPct', () => {
    // Columns stored backwards: durable_band_lo=56, durable_band_hi=44 (lo > hi).
    const g = zone2BarGeometry(
      row({ durable_base: 40, sharpness: 10, durable_band_lo: 56, durable_band_hi: 44 }),
      C_D,
      C_F
    )
    expect(g.hasBand).toBe(true)
    // min/max re-orders regardless of which column carried which value.
    expect(g.bandLoPct).toBeCloseTo(44, 5)
    expect(g.bandHiPct).toBeCloseTo(56, 5)
    expect(g.bandHiPct).toBeGreaterThanOrEqual(g.bandLoPct)
  })
})
