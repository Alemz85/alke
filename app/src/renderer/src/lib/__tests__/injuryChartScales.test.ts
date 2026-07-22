import { describe, expect, it } from 'vitest'
import { buildPainTimeAxis, formatPainAxisDate } from '../injuryChartScales'

function dateRange(startYMD: string, days: number): string[] {
  const start = Date.parse(`${startYMD}T00:00:00Z`)
  return Array.from({ length: days }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10)
  )
}

describe('buildPainTimeAxis', () => {
  it('uses fixed biweekly UTC ticks across the 90-day pain window', () => {
    const dates = dateRange('2026-04-23', 91)

    const axis = buildPainTimeAxis(dates)

    expect(axis.domain).toEqual([
      Date.parse('2026-04-23T00:00:00Z'),
      Date.parse('2026-07-22T00:00:00Z')
    ])
    expect(axis.ticks.map((tick) => new Date(tick).toISOString().slice(0, 10))).toEqual([
      '2026-05-04',
      '2026-05-18',
      '2026-06-01',
      '2026-06-15',
      '2026-06-29',
      '2026-07-13'
    ])
    expect(axis.ticks.slice(1).map((tick, index) => tick - axis.ticks[index])).toEqual(
      Array(axis.ticks.length - 1).fill(14 * 86_400_000)
    )
  })

  it('formats every tick as one unique month-day label', () => {
    const labels = buildPainTimeAxis(dateRange('2026-04-23', 91)).ticks.map(formatPainAxisDate)

    expect(new Set(labels).size).toBe(labels.length)
    expect(formatPainAxisDate(Date.parse('2026-07-20T00:00:00Z'))).toBe('07-20')
  })
})
