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
  zone2Meters,
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

describe('zone2CalendarGuidance (v4: build window + phase gate)', () => {
  const TODAY = '2026-07-10' // Friday

  it('anchors the build window at the LAST SESSION + cadence (not the row date)', () => {
    // Last aerobic session 07-08, cadence 2d → due 07-10 (today). The window is
    // the 2-day band ending at/after the deadline, clamped forward.
    const g = zone2CalendarGuidance(
      { date: '2026-07-09', warn_after_days: null, maintain_horizon_days: null, build_interval_days: 2 },
      ['2026-07-08'],
      TODAY
    )
    // due = 07-08 + 2 = 07-10 = today → due now. Window = [today, today+1].
    expect(g.buildWindow).toEqual({ start: '2026-07-10', end: '2026-07-11' })
    expect(g.buildOverdue).toBe(true)
    // BOTH window cells carry the build marker; nothing else in the building phase.
    expect(Object.keys(g.markers).sort()).toEqual(['2026-07-10', '2026-07-11'])
    expect(g.markers['2026-07-10'].kind).toBe('build')
    expect(g.markers['2026-07-11'].kind).toBe('build')
  })

  it('places a future build window as the 2 days ending at the cadence deadline', () => {
    // Last session 07-09, cadence 3 → due 07-12 (future). Window = [07-11, 07-12].
    const g = zone2CalendarGuidance(
      { date: '2026-07-10', warn_after_days: null, maintain_horizon_days: null, build_interval_days: 3 },
      ['2026-07-09'],
      TODAY
    )
    expect(g.buildWindow).toEqual({ start: '2026-07-11', end: '2026-07-12' })
    expect(g.buildOverdue).toBe(false)
  })

  it('shows an overdue build window as today→tomorrow with "due now" copy', () => {
    // Last session 07-01, cadence 2 → due 07-03, long past. Window clamps forward.
    const g = zone2CalendarGuidance(
      { date: '2026-07-10', warn_after_days: null, maintain_horizon_days: null, build_interval_days: 2 },
      ['2026-07-01'],
      TODAY
    )
    expect(g.buildWindow).toEqual({ start: '2026-07-10', end: '2026-07-11' })
    expect(g.buildOverdue).toBe(true)
    expect(g.markers['2026-07-10'].label).toMatch(/due now/i)
  })

  it('anchors the build window at today when no session is on record', () => {
    const g = zone2CalendarGuidance(
      { date: '2026-07-10', warn_after_days: null, maintain_horizon_days: null, build_interval_days: 2 },
      [],
      TODAY
    )
    // due = today + 2 = 07-12 → window [07-11, 07-12].
    expect(g.buildWindow).toEqual({ start: '2026-07-11', end: '2026-07-12' })
    expect(g.lastSession).toBeNull()
  })

  it('BUILDING phase (warn_after_days null): only the build window, no eases/hold', () => {
    // A thin base whose durable range is smaller than the band → the job stored a
    // null eases horizon. maintain_horizon may still be present, but it must NOT
    // surface — there is nothing banked to protect yet.
    const g = zone2CalendarGuidance(
      { date: '2026-07-10', warn_after_days: null, maintain_horizon_days: 8, build_interval_days: 2 },
      ['2026-07-08'],
      TODAY
    )
    expect(g.phase).toBe('building')
    expect(g.easesFrom).toBeNull()
    expect(g.holdBy).toBeNull()
    // No decay/maintain markers anywhere — only the two build-window cells.
    expect(Object.values(g.markers).every((m) => m.kind === 'build')).toBe(true)
    expect(g.summary).toMatch(/still thin|just build/i)
  })

  it('MAINTENANCE phase (warn_after_days present): eases + hold anchored at the ROW date', () => {
    // A banked base: the job stored a real eases horizon. eases/hold are FROM-TODAY
    // durable-erosion projections, so they anchor at the ROW date, while the build
    // window still anchors at the last session.
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 14, maintain_horizon_days: 6, build_interval_days: 2 },
      ['2026-07-08'],
      TODAY
    )
    expect(g.phase).toBe('maintenance')
    expect(g.easesFrom).toBe('2026-07-22') // rowDate 07-08 + 14
    expect(g.holdBy).toBe('2026-07-14') // rowDate 07-08 + 6
    // Build window anchored at last session 07-08 + 2 = 07-10 (due today).
    expect(g.buildWindow).toEqual({ start: '2026-07-10', end: '2026-07-11' })
    const kinds = Object.values(g.markers).map((m) => m.kind).sort()
    expect(kinds).toEqual(['build', 'build', 'decay', 'maintain'])
  })

  it('build markers win a same-day collision with an eases/hold marker', () => {
    // rowDate 07-10, maintain_horizon 1 → holdBy 07-11, which collides with the
    // build window's end cell (07-11). The build marker must survive.
    const g = zone2CalendarGuidance(
      { date: '2026-07-10', warn_after_days: 5, maintain_horizon_days: 1, build_interval_days: 2 },
      ['2026-07-10'],
      TODAY
    )
    // due = 07-10 + 2 = 07-12 → window [07-11, 07-12]; holdBy = 07-10 + 1 = 07-11.
    expect(g.buildWindow).toEqual({ start: '2026-07-11', end: '2026-07-12' })
    expect(g.holdBy).toBe('2026-07-11')
    expect(g.markers['2026-07-11'].kind).toBe('build') // build wins the collision
  })

  it('derives the build dose frequency from build_interval_days, not a hardcoded dose', () => {
    const everyTwo = zone2CalendarGuidance(
      { date: '2026-07-10', warn_after_days: null, maintain_horizon_days: null, build_interval_days: 2 },
      [],
      TODAY
    )
    expect(everyTwo.buildDose).toContain('every ~2 days')
    expect(everyTwo.buildDose).toMatch(/≈3\.5\/wk/)
    expect(everyTwo.buildDose).toContain('at Zone 2 intensity')
    expect(everyTwo.buildDose).not.toContain('40–50 min')
  })

  it('omits the build window when build_interval_days is null (old pre-migration rows)', () => {
    const g = zone2CalendarGuidance(
      { date: '2026-07-08', warn_after_days: 12, maintain_horizon_days: null, build_interval_days: null },
      [],
      TODAY
    )
    expect(g.buildWindow).toBeNull()
    expect(g.buildDose).toBeNull()
    // warn present → maintenance phase → the eases marker still shows.
    expect(g.phase).toBe('maintenance')
    expect(g.easesFrom).toBe('2026-07-20')
    expect(Object.values(g.markers).map((m) => m.kind)).toEqual(['decay'])
  })

  it('returns unknown/empty guidance when the row itself is missing', () => {
    const g = zone2CalendarGuidance(null, ['2026-07-08'], TODAY)
    expect(g.phase).toBe('unknown')
    expect(g.buildWindow).toBeNull()
    expect(g.easesFrom).toBeNull()
    expect(g.holdBy).toBeNull()
    expect(g.markers).toEqual({})
    expect(g.buildDose).toBeNull()
    // lastSession/sessions7d still computed from session history (copy only).
    expect(g.lastSession).toBe('2026-07-08')
  })

  it('counts sessions in the trailing 7 days and clamps future-dated sessions', () => {
    // 07-04..07-10 inclusive is the window; 07-03 is out, 07-11 is future.
    const g = zone2CalendarGuidance(
      { date: '2026-07-10', warn_after_days: null, maintain_horizon_days: null, build_interval_days: 3 },
      ['2026-07-03', '2026-07-04', '2026-07-08', '2026-07-10', '2026-07-11'],
      TODAY
    )
    expect(g.sessions7d).toBe(3) // 07-04, 07-08, 07-10
    expect(g.lastSession).toBe('2026-07-10') // future 07-11 clamped to today
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

describe('zone2Meters (v4 two-bar layout)', () => {
  it('fills each meter against its OWN ceiling', () => {
    // D=35 of 70 → 50%; F=15 of 30 → 50%.
    const m = zone2Meters(row({ durable_base: 35, sharpness: 15 }), C_D, C_F)
    expect(m.durableValue).toBe(35)
    expect(m.durablePct).toBeCloseTo(50, 5)
    expect(m.fastValue).toBe(15)
    expect(m.fastPct).toBeCloseTo(50, 5)
  })

  it('a thin base and a fuller form fill their own bars independently', () => {
    // D=7/70 → 10%; F=11/30 → ~36.7% — the honest beginner picture (little base,
    // more recent form), each read against its own ceiling.
    const m = zone2Meters(row({ durable_base: 7, sharpness: 11 }), C_D, C_F)
    expect(m.durablePct).toBeCloseTo(10, 5)
    expect(m.fastPct).toBeCloseTo((11 / 30) * 100, 5)
    expect(m.fastPct).toBeGreaterThan(m.durablePct)
  })

  it('clamps a component that exceeds its ceiling (fill never passes 100%)', () => {
    const m = zone2Meters(row({ durable_base: 90, sharpness: 45 }), C_D, C_F)
    expect(m.durableValue).toBe(70)
    expect(m.durablePct).toBeCloseTo(100, 5)
    expect(m.fastValue).toBe(30)
    expect(m.fastPct).toBeCloseTo(100, 5)
  })

  it('treats null components as 0 (empty bars)', () => {
    const m = zone2Meters(row({ durable_base: null, sharpness: null }), C_D, C_F)
    expect(m.durableValue).toBe(0)
    expect(m.durablePct).toBe(0)
    expect(m.fastValue).toBe(0)
    expect(m.fastPct).toBe(0)
  })

  it('guards a degenerate ceiling config without dividing by zero', () => {
    const m = zone2Meters(row({ durable_base: 10, sharpness: 5 }), 0, 0)
    expect(m.durablePct).toBe(0)
    expect(m.fastPct).toBe(0)
  })
})
