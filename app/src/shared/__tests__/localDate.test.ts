import { describe, expect, it } from 'vitest'
import { dateKeyInTimeZone } from '../localDate'

describe('dateKeyInTimeZone', () => {
  it('advances to the athlete calendar date after local midnight', () => {
    expect(dateKeyInTimeZone('2026-01-15T23:30:00Z', 'Europe/Berlin')).toBe('2026-01-16')
  })

  it('moves back a day west of UTC when appropriate', () => {
    expect(dateKeyInTimeZone('2026-01-15T02:00:00Z', 'America/New_York')).toBe('2026-01-14')
  })

  it('falls back to the UTC date when a persisted timezone is invalid', () => {
    expect(dateKeyInTimeZone('2026-01-15T23:30:00Z', 'Not/A_Zone')).toBe('2026-01-15')
  })

  it('rejects invalid instants instead of producing malformed date keys', () => {
    expect(() => dateKeyInTimeZone('not-a-date', 'Europe/Berlin')).toThrow('invalid date instant')
  })
})
