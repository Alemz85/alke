import { describe, expect, it } from 'vitest'
import {
  buildInsightScatter,
  insightAxis,
  insightWindowStart,
  rollingCalendarMedianDeviation,
  rollingCalendarMedianDelta,
  rollingWeightTrend,
  sleepAwakeFraction,
  sleepMidpointHours
} from '../insightSeries'

describe('sleepMidpointHours', () => {
  it('measures the midpoint from wake-day midnight in the configured timezone', () => {
    expect(
      sleepMidpointHours(
        '2026-01-15T22:00:00Z',
        '2026-01-16T06:00:00Z',
        'Europe/Berlin'
      )
    ).toBeCloseTo(3)
    expect(
      sleepMidpointHours(
        '2026-07-15T21:00:00Z',
        '2026-07-16T05:00:00Z',
        'Europe/Berlin'
      )
    ).toBeCloseTo(3)
  })

  it('expresses the actual midpoint instant on the local clock across DST', () => {
    expect(
      sleepMidpointHours(
        '2026-03-28T22:00:00Z',
        '2026-03-29T05:00:00Z',
        'Europe/Berlin'
      )
    ).toBeCloseTo(3.5)
  })

  it('uses a differing recorded offset when the sleep happened away from home', () => {
    expect(
      sleepMidpointHours(
        '2026-07-08T00:00:00Z',
        '2026-07-08T08:00:00Z',
        'Europe/Berlin',
        60
      )
    ).toBeCloseTo(5)
  })
})

describe('buildInsightScatter', () => {
  it('uses the requested lag and excludes observations before the model window', () => {
    const xs = new Map([
      ['2026-01-01', 1],
      ['2026-07-01', 7],
      ['2026-07-02', 8]
    ])
    const ys = new Map([
      ['2026-01-02', 10],
      ['2026-07-02', 70],
      ['2026-07-03', 80]
    ])

    expect(buildInsightScatter(xs, ys, 1, '2026-07-02')).toEqual([
      { x: 7, y: 70, date: '2026-07-02' },
      { x: 8, y: 80, date: '2026-07-03' }
    ])
  })

  it('can condition load points on days with positive measured load', () => {
    const xs = new Map([
      ['2026-07-01', 7],
      ['2026-07-02', 8]
    ])
    const ys = new Map([
      ['2026-07-01', 0],
      ['2026-07-02', 50]
    ])

    expect(buildInsightScatter(xs, ys, 0, '2026-07-01', true)).toEqual([
      { x: 8, y: 50, date: '2026-07-02' }
    ])
  })
})

describe('insightWindowStart', () => {
  it('anchors the 180-day window to the nightly model date in the user timezone', () => {
    expect(insightWindowStart('2026-08-02T03:30:00Z', 'Europe/Berlin')).toBe('2026-02-04')
    expect(insightWindowStart('2026-08-02T03:30:00Z', 'America/Los_Angeles')).toBe(
      '2026-02-03'
    )
  })
})

describe('rollingCalendarMedianDeviation', () => {
  it('uses prior calendar days and excludes the current observation', () => {
    const midpoints = new Map([
      ['2026-01-01', 1],
      ['2026-01-02', 2],
      ['2026-01-03', 3],
      ['2026-01-04', 4],
      ['2026-01-05', 5],
      ['2026-01-20', 10],
      ['2026-01-21', 11],
      ['2026-01-22', 12],
      ['2026-01-23', 13],
      ['2026-01-24', 14],
      ['2026-01-25', 15]
    ])

    const deviations = rollingCalendarMedianDeviation(midpoints, 14, 5)

    expect(deviations.has('2026-01-20')).toBe(false)
    expect(deviations.has('2026-01-24')).toBe(false)
    expect(deviations.get('2026-01-25')).toBe(3)
  })

  it('keeps a current extreme out of its own signed baseline', () => {
    const values = new Map([
      ['2026-01-01', 8], ['2026-01-02', 8], ['2026-01-03', 8],
      ['2026-01-04', 8], ['2026-01-10', 20], ['2026-01-11', 7]
    ])

    const deltas = rollingCalendarMedianDelta(values, 7, 2)

    expect(deltas.get('2026-01-10')).toBe(12)
    expect(deltas.get('2026-01-11')).toBe(-7)
  })
})

describe('sleepAwakeFraction', () => {
  it('uses the internally consistent stage units and rejects malformed stages', () => {
    expect(sleepAwakeFraction({ awake: 0.5, core: 4.5, deep: 1, rem: 2 })).toBeCloseTo(
      0.5 / 8
    )
    expect(sleepAwakeFraction({ awake: 0.5, core: 4.5 })).toBeNull()
  })
})

describe('rollingWeightTrend', () => {
  it('mirrors the three-day fill and seven-day mean delta used by metrics', () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      value: index === 0 ? 80 : index === 7 ? 79 : null
    }))

    const trend = rollingWeightTrend(rows)

    expect(trend.get('2026-01-11')).toBeCloseTo(-1)
    expect(trend.has('2026-01-15')).toBe(false)
  })
})

describe('insightAxis', () => {
  it('uses a nice D3 domain and remains valid for a constant series', () => {
    expect(insightAxis([1.2, 4.8], 5).domain).toEqual([1, 5])
    const constant = insightAxis([3, 3, 3], 5)
    expect(constant.domain[0]).toBeLessThan(3)
    expect(constant.domain[1]).toBeGreaterThan(3)
    expect(constant.ticks.length).toBeGreaterThan(1)
  })
})
