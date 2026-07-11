import { describe, expect, it } from 'vitest'
import {
  EM_DASH,
  fmtDelta,
  fmtNum,
  formatClock,
  formatClockDuration,
  formatDurationHM,
  formatPace100,
  formatPerMonth,
  formatTrendPct
} from '../format'

describe('durations', () => {
  it('formatClockDuration matches the old sessionsCompute behavior', () => {
    expect(formatClockDuration(45 * 60)).toBe('45m')
    expect(formatClockDuration(105 * 60)).toBe('1:45')
    expect(formatClockDuration(3600)).toBe('1:00')
  })
  it('formatDurationHM matches the old calendarDayLabel behavior', () => {
    expect(formatDurationHM(45 * 60)).toBe('45m')
    expect(formatDurationHM(105 * 60)).toBe('1h 45m')
    expect(formatDurationHM(7200)).toBe('2h')
    expect(formatDurationHM(-5)).toBe('0m')
  })
  it('formatClock never emits :60', () => {
    expect(formatClock(119.6)).toBe('2:00')
    expect(formatClock(64)).toBe('1:04')
  })
})

describe('pace / numbers', () => {
  it('formatPace100 handles null', () => {
    expect(formatPace100(136)).toBe('2:16')
    expect(formatPace100(null)).toBe(EM_DASH)
  })
  it('fmtNum / fmtDelta match the old dashboardUtils behavior', () => {
    expect(fmtNum(2.345)).toBe('2.3')
    expect(fmtNum(null)).toBe(EM_DASH)
    expect(fmtDelta(2.3)).toBe('+2.3')
    expect(fmtDelta(-1.1)).toBe('-1.1')
    expect(fmtDelta(0)).toBe('±0.0')
  })
  it('formatTrendPct and formatPerMonth match the old header helpers', () => {
    expect(formatTrendPct(158.4)).toBe('+158%')
    expect(formatTrendPct(-12.2)).toBe('-12%')
    expect(formatTrendPct(null)).toBe(EM_DASH)
    expect(formatPerMonth(4)).toBe('4')
    expect(formatPerMonth(4.25)).toBe('4.3')
  })
})
