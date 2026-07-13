import { describe, expect, it } from 'vitest'
import { buildNumericAxis } from '../cardioChartScales'

describe('buildNumericAxis', () => {
  it('pads a tightly clustered metric so a trend does not touch the plot edges', () => {
    const axis = buildNumericAxis([102, 104, 106], { tickCount: 4 })

    expect(axis.domain[0]).toBeLessThan(102)
    expect(axis.domain[1]).toBeGreaterThan(106)
    expect(axis.ticks.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps volume axes anchored at zero', () => {
    const axis = buildNumericAxis([18, 42, 61], { includeZero: true, tickCount: 4 })

    expect(axis.domain[0]).toBe(0)
    expect(axis.domain[1]).toBeGreaterThanOrEqual(61)
    expect(axis.ticks[0]).toBe(0)
  })

  it('creates a useful domain for a flat series', () => {
    const axis = buildNumericAxis([35, 35, null, undefined], { tickCount: 4 })

    expect(axis.domain[0]).toBeLessThan(35)
    expect(axis.domain[1]).toBeGreaterThan(35)
  })

  it('returns a stable fallback for missing data', () => {
    expect(buildNumericAxis([], { includeZero: true })).toEqual({
      domain: [0, 1],
      ticks: [0, 0.2, 0.4, 0.6, 0.8, 1]
    })
  })
})
