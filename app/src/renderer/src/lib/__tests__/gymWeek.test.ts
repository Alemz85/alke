import { describe, expect, it } from 'vitest'
import type { GymSession } from '@shared/types'
import { gymWeekDays } from '../gymWeek'

function session(id: string, performedAt: string): GymSession {
  return {
    id,
    workout_id: null,
    template_id: null,
    template_ids: [],
    performed_at: performedAt,
    title: null,
    notes: null,
    source: 'user',
    body_parts: null,
    sets: [],
    created_at: null,
    updated_at: null
  }
}

describe('gymWeekDays', () => {
  it('returns seven local days and only the Gym sessions in the selected ISO week', () => {
    const days = gymWeekDays(
      [
        session('mon', '2026-07-06T16:15:00.000Z'),
        session('thu', '2026-07-09T16:15:00.000Z'),
        session('sun', '2026-07-12T16:15:00.000Z'),
        session('prior', '2026-07-05T16:15:00.000Z')
      ],
      { year: 2026, month: 7, day: 6 },
      'UTC'
    )

    expect(days).toHaveLength(7)
    expect(days.map((day) => day.dateKey)).toEqual([
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12'
    ])
    expect(days[0].sessions.map((item) => item.id)).toEqual(['mon'])
    expect(days[3].sessions.map((item) => item.id)).toEqual(['thu'])
    expect(days[6].sessions.map((item) => item.id)).toEqual(['sun'])
    expect(days[1].sessions).toEqual([])
  })
})
