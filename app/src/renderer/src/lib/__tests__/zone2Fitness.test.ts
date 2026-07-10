import { describe, expect, it } from 'vitest'
import type { Zone2Fitness } from '@shared/types'
import { ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING } from '@shared/types'
import {
  durableBandCaption,
  durableBandHalfWidth,
  evidenceReason,
  hasMaintenanceFlag,
  indexBandHalfWidth,
  latestZone2Row,
  maintenanceMessage,
  sharpnessSparkline,
  stageLabel,
  TAU_FAST_DAYS,
  zone2BarGeometry,
  zone2IndexValue,
  zone2ProjectionSeries
} from '../zone2Fitness'

const C_D = ZONE2_DURABLE_CEILING // 70
const C_F = ZONE2_FAST_CEILING // 30

// Minimal row factory — only the fields under test carry meaning; the rest are nulled.
function row(overrides: Partial<Zone2Fitness>): Zone2Fitness {
  return {
    date: '2026-07-10',
    durable_base: null,
    durable_band_lo: null,
    durable_band_hi: null,
    sharpness: null,
    vo2max_anchor_score: null,
    anchor_beta: null,
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

  it('never returns a negative width', () => {
    expect(durableBandHalfWidth(row({ durable_band_lo: 50, durable_band_hi: 40 }))).toBe(0)
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

describe('zone2ProjectionSeries', () => {
  it('returns historical points unchanged and appends a dotted tail', () => {
    const rows = [
      row({ date: '2026-07-08', durable_base: 40, sharpness: 50, floor_score: 10, tau_slow_days: 45 }),
      row({ date: '2026-07-10', durable_base: 42, sharpness: 48, floor_score: 10, tau_slow_days: 45 })
    ]
    const series = zone2ProjectionSeries(rows, 14)

    // Two historical points, both solid.
    const historical = series.filter((p) => !p.projected)
    expect(historical).toHaveLength(2)
    expect(historical[0].durable).toBe(40)
    expect(historical[1].sharpness).toBe(48)

    // The seam (last historical point) also carries projected values so the dotted line connects.
    const seam = historical[1]
    expect(seam.durableProjected).toBe(42)
    expect(seam.sharpnessProjected).toBe(48)

    // 14 projected days appended.
    const projected = series.filter((p) => p.projected)
    expect(projected).toHaveLength(14)
    expect(projected[0].date).toBe('2026-07-11')
    expect(projected[13].date).toBe('2026-07-24')
  })

  it('decays sharpness toward 0 with tau_fast and durable toward floor with tau_slow', () => {
    const rows = [row({ date: '2026-07-10', durable_base: 42, sharpness: 48, floor_score: 10, tau_slow_days: 45 })]
    const series = zone2ProjectionSeries(rows, 14)
    const projected = series.filter((p) => p.projected)

    // Day 14 sharpness ≈ 48·e^(-14/14) = 48·e^-1 ≈ 17.66 → 17.7
    const day14 = projected[13]
    expect(day14.sharpnessProjected).toBeCloseTo(48 * Math.exp(-14 / TAU_FAST_DAYS), 1)
    // Durable stays above its floor and below the start.
    expect(day14.durableProjected!).toBeGreaterThan(10)
    expect(day14.durableProjected!).toBeLessThan(42)
    // Durable monotonically decreases toward the floor.
    expect(projected[0].durableProjected!).toBeGreaterThan(day14.durableProjected!)
  })

  it('never projects durable below the floor', () => {
    const rows = [row({ date: '2026-07-10', durable_base: 42, sharpness: 48, floor_score: 30, tau_slow_days: 45 })]
    const series = zone2ProjectionSeries(rows, 90)
    for (const p of series.filter((x) => x.projected)) {
      expect(p.durableProjected!).toBeGreaterThanOrEqual(30)
    }
  })

  it('returns only the historical points when the latest row has no values', () => {
    const rows = [row({ date: '2026-07-10', durable_base: null, sharpness: null })]
    const series = zone2ProjectionSeries(rows, 14)
    expect(series.every((p) => !p.projected)).toBe(true)
    expect(series).toHaveLength(1)
  })

  it('returns an empty series for no rows', () => {
    expect(zone2ProjectionSeries([], 14)).toEqual([])
  })
})

describe('sharpnessSparkline', () => {
  it('returns the last N non-null sharpness values oldest→newest, reindexed', () => {
    const rows = [
      row({ date: '2026-07-08', sharpness: 30 }),
      row({ date: '2026-07-09', sharpness: null }),
      row({ date: '2026-07-10', sharpness: 40 })
    ]
    const spark = sharpnessSparkline(rows, 10)
    expect(spark).toEqual([
      { i: 0, value: 30 },
      { i: 1, value: 40 }
    ])
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
})
