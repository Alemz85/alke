import { describe, expect, it } from 'vitest'
import { rhrRecent, zoneRanges, zoneThresholds } from '../hrZones'

describe('zoneThresholds', () => {
  it('mirrors metrics/models.py zone_bounds (Karvonen, 0.10 steps above Z2 band)', () => {
    // hr_max 190, rhr 50 -> hrr 140; defaults z2 0.60-0.70
    expect(zoneThresholds(190, 50)).toEqual([134, 148, 162, 176])
  })
  it('respects configurable Z2 band', () => {
    const [t2, t3] = zoneThresholds(190, 50, 0.65, 0.75)
    expect(t2).toBeCloseTo(141)
    expect(t3).toBeCloseTo(155)
  })
})

describe('zoneRanges', () => {
  it('produces five contiguous ranges from resting to open-ended Z5', () => {
    const ranges = zoneRanges(190, 50)
    expect(ranges.map((r) => r.fromBpm)).toEqual([50, 134, 148, 162, 176])
    expect(ranges[0].toBpm).toBe(134)
    expect(ranges[4].toBpm).toBeNull()
  })
})

describe('rhrRecent', () => {
  it('takes the 7-day median when readings exist', () => {
    const byDate = new Map([
      ['2026-07-11', 52],
      ['2026-07-10', 54],
      ['2026-07-08', 50]
    ])
    expect(rhrRecent(byDate, '2026-07-11')).toBe(52)
  })
  it('falls back to the 60-day window, then to 60 bpm', () => {
    const stale = new Map([['2026-06-01', 55]])
    expect(rhrRecent(stale, '2026-07-11')).toBe(55)
    expect(rhrRecent(new Map(), '2026-07-11')).toBe(60)
  })
})
