import { describe, expect, it } from 'vitest'
import type { Goal, GoalProgressPoint, Workout } from '@shared/types'
import {
  achievements,
  ageFromBirthdate,
  metricProgress,
  profileStats,
  sinceLabel,
  timeProgress
} from '../profileStats'

// Fixed "now" so all windows are deterministic. 2026-07-10 is a Friday, ISO
// week starting Mon 2026-07-06.
const NOW = new Date('2026-07-10T12:00:00Z')

let idCounter = 0
function workout(partial: Partial<Workout> & { start_at: string }): Workout {
  idCounter += 1
  return {
    id: `w-${idCounter}`,
    external_id: null,
    type: 'running',
    end_at: null,
    duration_s: 1800,
    distance_m: null,
    energy_kcal: null,
    avg_hr: null,
    max_hr: null,
    source: null,
    computed: null,
    ...partial
  }
}

function goal(partial: Partial<Goal> & { id: string }): Goal {
  return {
    title: 'Goal',
    description: null,
    status: 'active',
    started_at: '2026-06-01',
    status_changed_at: null,
    duration_days: null,
    created_by: 'user',
    metric_name: null,
    metric_description: null,
    metric_sql: null,
    metric_direction: null,
    metric_unit: null,
    metric_baseline: null,
    metric_target: null,
    created_at: null,
    updated_at: null,
    ...partial
  }
}

// ── profileStats ─────────────────────────────────────────────────────────────

describe('profileStats', () => {
  it('returns zeros/nulls for no workouts', () => {
    const s = profileStats([], NOW)
    expect(s).toEqual({
      workoutCount: 0,
      totalHours: 0,
      totalSwimKm: 0,
      activeWeeks: 0,
      currentStreakWeeks: 0,
      longestStreakWeeks: 0,
      trackingSince: null
    })
  })

  it('sums workout count, hours, and swim km', () => {
    const workouts = [
      workout({ start_at: '2026-07-10T08:00:00Z', duration_s: 3600, type: 'running' }),
      workout({
        start_at: '2026-07-09T08:00:00Z',
        duration_s: 1800,
        type: 'pool_swim',
        distance_m: 1500
      }),
      workout({
        start_at: '2026-07-08T08:00:00Z',
        duration_s: 1800,
        type: 'open_water_swim',
        distance_m: 2500
      })
    ]
    const s = profileStats(workouts, NOW)
    expect(s.workoutCount).toBe(3)
    expect(s.totalHours).toBeCloseTo(1 + 0.5 + 0.5, 5)
    expect(s.totalSwimKm).toBeCloseTo(4, 5) // 1500 + 2500 = 4000m
  })

  it('ignores non-swim distance and null distance for swim km', () => {
    const workouts = [
      workout({ start_at: '2026-07-10T08:00:00Z', type: 'cycling', distance_m: 20000 }),
      workout({ start_at: '2026-07-09T08:00:00Z', type: 'pool_swim', distance_m: null })
    ]
    const s = profileStats(workouts, NOW)
    expect(s.totalSwimKm).toBe(0)
  })

  it('tracks earliest workout as trackingSince', () => {
    const workouts = [
      workout({ start_at: '2026-07-10T08:00:00Z' }),
      workout({ start_at: '2026-01-01T08:00:00Z' }),
      workout({ start_at: '2026-05-01T08:00:00Z' })
    ]
    expect(profileStats(workouts, NOW).trackingSince).toBe('2026-01-01')
  })

  it('counts distinct active ISO weeks, not workout count', () => {
    const workouts = [
      workout({ start_at: '2026-07-06T08:00:00Z' }), // week of Jul 6
      workout({ start_at: '2026-07-08T08:00:00Z' }), // same week
      workout({ start_at: '2026-06-29T08:00:00Z' }) // prior week
    ]
    expect(profileStats(workouts, NOW).activeWeeks).toBe(2)
  })

  it('computes longest streak across non-consecutive weeks', () => {
    const workouts = [
      // 3-week streak: Jun 1, 8, 15
      workout({ start_at: '2026-06-01T08:00:00Z' }),
      workout({ start_at: '2026-06-08T08:00:00Z' }),
      workout({ start_at: '2026-06-15T08:00:00Z' }),
      // gap (Jun 22 skipped)
      // 1-week run: Jul 6 (this week)
      workout({ start_at: '2026-07-06T08:00:00Z' })
    ]
    const s = profileStats(workouts, NOW)
    expect(s.longestStreakWeeks).toBe(3)
  })

  it('current streak is 0 when the most recent active week is more than 1 week stale', () => {
    const workouts = [workout({ start_at: '2026-06-01T08:00:00Z' })]
    expect(profileStats(workouts, NOW).currentStreakWeeks).toBe(0)
  })

  it('current streak counts consecutive weeks ending this week', () => {
    const workouts = [
      workout({ start_at: '2026-06-22T08:00:00Z' }),
      workout({ start_at: '2026-06-29T08:00:00Z' }),
      workout({ start_at: '2026-07-06T08:00:00Z' }) // this week
    ]
    expect(profileStats(workouts, NOW).currentStreakWeeks).toBe(3)
  })

  it('current streak counts through last week when this week has no workout yet', () => {
    const workouts = [
      workout({ start_at: '2026-06-22T08:00:00Z' }),
      workout({ start_at: '2026-06-29T08:00:00Z' }) // last week, not this week
    ]
    expect(profileStats(workouts, NOW).currentStreakWeeks).toBe(2)
  })
})

// ── achievements ─────────────────────────────────────────────────────────────

describe('achievements', () => {
  it('earns "first workout" on a single workout and nothing higher', () => {
    const workouts = [workout({ start_at: '2026-07-10T08:00:00Z' })]
    const list = achievements(workouts, NOW)
    const first = list.find((a) => a.id === 'workouts-1')
    const ten = list.find((a) => a.id === 'workouts-10')
    expect(first?.earned).toBe(true)
    expect(first?.earnedDate).toBe('2026-07-10')
    expect(ten?.earned).toBe(false)
    expect(ten?.earnedDate).toBeUndefined()
  })

  it('earns workout-count milestones at the crossing workout, chronological order', () => {
    const workouts = Array.from({ length: 10 }, (_, i) =>
      workout({ start_at: `2026-06-${String(i + 1).padStart(2, '0')}T08:00:00Z` })
    )
    const list = achievements(workouts, NOW)
    const ten = list.find((a) => a.id === 'workouts-10')
    expect(ten?.earned).toBe(true)
    expect(ten?.earnedDate).toBe('2026-06-10')
  })

  it('earns hours milestones cumulatively at the crossing workout', () => {
    // 10 workouts x 1h = 10h total, crossing at the 10th.
    const workouts = Array.from({ length: 10 }, (_, i) =>
      workout({ start_at: `2026-06-${String(i + 1).padStart(2, '0')}T08:00:00Z`, duration_s: 3600 })
    )
    const list = achievements(workouts, NOW)
    const hours10 = list.find((a) => a.id === 'hours-10')
    expect(hours10?.earned).toBe(true)
    expect(hours10?.earnedDate).toBe('2026-06-10')
    expect(list.find((a) => a.id === 'hours-50')?.earned).toBe(false)
  })

  it('earns swim milestones from cumulative swim distance only', () => {
    const workouts = [
      workout({ start_at: '2026-07-01T08:00:00Z', type: 'pool_swim', distance_m: 6000 }),
      workout({ start_at: '2026-07-05T08:00:00Z', type: 'pool_swim', distance_m: 5000 }),
      workout({ start_at: '2026-07-08T08:00:00Z', type: 'cycling', distance_m: 50000 }) // not a swim
    ]
    const list = achievements(workouts, NOW)
    const firstSwim = list.find((a) => a.id === 'swim-first')
    const swim10 = list.find((a) => a.id === 'swim-10')
    expect(firstSwim?.earned).toBe(true)
    expect(firstSwim?.earnedDate).toBe('2026-07-01')
    expect(swim10?.earned).toBe(true)
    expect(swim10?.earnedDate).toBe('2026-07-05') // 6000+5000=11000m >= 10km
  })

  it('earns streak milestones at the week that completes the run', () => {
    const workouts = [
      workout({ start_at: '2026-06-01T08:00:00Z' }), // week of Jun 1 (Mon Jun 1)
      workout({ start_at: '2026-06-08T08:00:00Z' }),
      workout({ start_at: '2026-06-15T08:00:00Z' }),
      workout({ start_at: '2026-06-22T08:00:00Z' }) // 4th consecutive week
    ]
    const list = achievements(workouts, NOW)
    const streak4 = list.find((a) => a.id === 'streak-4')
    expect(streak4?.earned).toBe(true)
    expect(streak4?.earnedDate).toBe('2026-06-22')
  })

  it('does not earn streak milestones when weeks are non-consecutive', () => {
    const workouts = [
      workout({ start_at: '2026-06-01T08:00:00Z' }),
      workout({ start_at: '2026-06-22T08:00:00Z' }) // gap — streak resets
    ]
    const list = achievements(workouts, NOW)
    expect(list.find((a) => a.id === 'streak-4')?.earned).toBe(false)
  })

  it('earns first-60-min-session on the first workout >= 3600s', () => {
    const workouts = [
      workout({ start_at: '2026-07-01T08:00:00Z', duration_s: 1200 }),
      workout({ start_at: '2026-07-05T08:00:00Z', duration_s: 3600 })
    ]
    const list = achievements(workouts, NOW)
    const badge = list.find((a) => a.id === 'session-60min')
    expect(badge?.earned).toBe(true)
    expect(badge?.earnedDate).toBe('2026-07-05')
  })

  it('earns first-2km-swim only for a single swim session >= 2000m', () => {
    const workouts = [
      workout({ start_at: '2026-07-01T08:00:00Z', type: 'pool_swim', distance_m: 1000 }),
      workout({ start_at: '2026-07-05T08:00:00Z', type: 'pool_swim', distance_m: 2200 })
    ]
    const list = achievements(workouts, NOW)
    const badge = list.find((a) => a.id === 'session-2km-swim')
    expect(badge?.earned).toBe(true)
    expect(badge?.earnedDate).toBe('2026-07-05')
  })

  it('returns the full ladder unearned for no workouts', () => {
    const list = achievements([], NOW)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((a) => !a.earned)).toBe(true)
    expect(list.every((a) => a.earnedDate === undefined)).toBe(true)
  })
})

// ── timeProgress ─────────────────────────────────────────────────────────────

describe('timeProgress', () => {
  it('returns null pct for an open-ended goal', () => {
    const g = goal({ id: 'g1', started_at: '2026-06-01', duration_days: null })
    const tp = timeProgress(g, NOW)
    expect(tp.pct).toBeNull()
    expect(tp.elapsedDays).toBe(39) // Jun 1 -> Jul 10
  })

  it('computes pct elapsed for a fixed-duration goal', () => {
    const g = goal({ id: 'g1', started_at: '2026-07-01', duration_days: 20 })
    const tp = timeProgress(g, NOW)
    expect(tp.elapsedDays).toBe(9)
    expect(tp.pct).toBe(45) // 9/20
  })

  it('clamps pct at 100 when past the duration', () => {
    const g = goal({ id: 'g1', started_at: '2026-01-01', duration_days: 10 })
    const tp = timeProgress(g, NOW)
    expect(tp.pct).toBe(100)
  })

  it('clamps elapsedDays at 0 for a future start date', () => {
    const g = goal({ id: 'g1', started_at: '2026-08-01', duration_days: 30 })
    const tp = timeProgress(g, NOW)
    expect(tp.elapsedDays).toBe(0)
    expect(tp.pct).toBe(0)
  })
})

// ── metricProgress ───────────────────────────────────────────────────────────

function point(date: string, value: number): GoalProgressPoint {
  return { goal_id: 'g1', date, value }
}

describe('metricProgress', () => {
  it('returns nulls when there are no progress points', () => {
    const g = goal({ id: 'g1' })
    expect(metricProgress(g, [])).toEqual({ latest: null, delta: null, pctToTarget: null })
  })

  it('picks the latest point by date, not array order', () => {
    const g = goal({ id: 'g1' })
    const points = [point('2026-07-05', 10), point('2026-07-10', 15), point('2026-07-01', 5)]
    expect(metricProgress(g, points).latest).toBe(15)
  })

  it('computes raw delta vs baseline', () => {
    const g = goal({ id: 'g1', metric_baseline: 10 })
    const points = [point('2026-07-10', 15)]
    expect(metricProgress(g, points).delta).toBe(5)
  })

  it('delta is null without a baseline', () => {
    const g = goal({ id: 'g1', metric_baseline: null })
    const points = [point('2026-07-10', 15)]
    expect(metricProgress(g, points).delta).toBeNull()
  })

  it('pctToTarget is null unless both baseline and target are present', () => {
    const points = [point('2026-07-10', 15)]
    expect(metricProgress(goal({ id: 'g1', metric_baseline: 10, metric_target: null }), points).pctToTarget).toBeNull()
    expect(metricProgress(goal({ id: 'g1', metric_baseline: null, metric_target: 20 }), points).pctToTarget).toBeNull()
  })

  it('computes pctToTarget direction-aware for an "up" goal', () => {
    const g = goal({ id: 'g1', metric_direction: 'up', metric_baseline: 10, metric_target: 20 })
    const points = [point('2026-07-10', 15)]
    expect(metricProgress(g, points).pctToTarget).toBe(50)
  })

  it('computes pctToTarget direction-aware for a "down" goal', () => {
    // baseline 20, target 10 (lower is progress); latest 15 -> halfway.
    const g = goal({ id: 'g1', metric_direction: 'down', metric_baseline: 20, metric_target: 10 })
    const points = [point('2026-07-10', 15)]
    expect(metricProgress(g, points).pctToTarget).toBe(50)
  })

  it('clamps pctToTarget to [0, 100] beyond the target or below baseline', () => {
    const g = goal({ id: 'g1', metric_direction: 'up', metric_baseline: 10, metric_target: 20 })
    expect(metricProgress(g, [point('2026-07-10', 30)]).pctToTarget).toBe(100)
    expect(metricProgress(g, [point('2026-07-10', 0)]).pctToTarget).toBe(0)
  })
})

// ── sinceLabel ───────────────────────────────────────────────────────────────

describe('sinceLabel', () => {
  it('active goal with no status_changed_at falls back to started_at', () => {
    const g = goal({ id: 'g1', status: 'active', started_at: '2026-07-01', status_changed_at: null })
    const s = sinceLabel(g, NOW)
    expect(s.anchorYMD).toBe('2026-07-01')
    expect(s.text).toBe('Active for 9 days · since')
  })

  it('active goal prefers status_changed_at over started_at', () => {
    const g = goal({
      id: 'g1',
      status: 'active',
      started_at: '2026-01-01',
      status_changed_at: '2026-07-05T00:00:00Z'
    })
    const s = sinceLabel(g, NOW)
    expect(s.anchorYMD).toBe('2026-07-05')
    expect(s.text).toBe('Active for 5 days · since')
  })

  it('pluralizes "day" singular at exactly 1 day', () => {
    const g = goal({ id: 'g1', status: 'active', started_at: '2026-07-09', status_changed_at: null })
    expect(sinceLabel(g, NOW).text).toBe('Active for 1 day · since')
  })

  it('on_hold goal reads "On hold since"', () => {
    const g = goal({
      id: 'g1',
      status: 'on_hold',
      started_at: '2026-06-01',
      status_changed_at: '2026-07-08T00:00:00Z'
    })
    const s = sinceLabel(g, NOW)
    expect(s.text).toBe('On hold since')
    expect(s.anchorYMD).toBe('2026-07-08')
  })

  it('completed goal reads "Completed"', () => {
    const g = goal({
      id: 'g1',
      status: 'completed',
      started_at: '2026-06-01',
      status_changed_at: '2026-07-09T00:00:00Z'
    })
    const s = sinceLabel(g, NOW)
    expect(s.text).toBe('Completed')
    expect(s.anchorYMD).toBe('2026-07-09')
  })

  it('abandoned goal reads "Abandoned"', () => {
    const g = goal({
      id: 'g1',
      status: 'abandoned',
      started_at: '2026-06-01',
      status_changed_at: '2026-07-02T00:00:00Z'
    })
    const s = sinceLabel(g, NOW)
    expect(s.text).toBe('Abandoned')
    expect(s.anchorYMD).toBe('2026-07-02')
  })

  it('clamps to 0 days for a future anchor', () => {
    const g = goal({ id: 'g1', status: 'active', started_at: '2026-08-01', status_changed_at: null })
    expect(sinceLabel(g, NOW).text).toBe('Active for 0 days · since')
  })
})

// ── ageFromBirthdate ─────────────────────────────────────────────────────────

describe('ageFromBirthdate', () => {
  it('returns null for a null/undefined birthdate', () => {
    expect(ageFromBirthdate(null, NOW)).toBeNull()
    expect(ageFromBirthdate(undefined, NOW)).toBeNull()
  })

  it('returns null for a malformed birthdate', () => {
    expect(ageFromBirthdate('not-a-date', NOW)).toBeNull()
    expect(ageFromBirthdate('1997-13-40', NOW)).toBeNull()
    expect(ageFromBirthdate('', NOW)).toBeNull()
  })

  it('computes a straightforward age (birthday already passed this year)', () => {
    // NOW is 2026-07-10; birthday 03-14 already passed.
    expect(ageFromBirthdate('1997-03-14', NOW)).toBe(29)
  })

  it('has not yet had the birthday this year — age is one less', () => {
    // NOW is 2026-07-10; birthday 12-25 hasn't happened yet this year.
    expect(ageFromBirthdate('1997-12-25', NOW)).toBe(28)
  })

  it('birthday is exactly today — age increments on the day itself', () => {
    const now = new Date('2026-07-10T12:00:00Z')
    expect(ageFromBirthdate('1997-07-10', now)).toBe(29)
  })

  it('the day before the birthday — still the pre-birthday age', () => {
    const now = new Date('2026-07-09T12:00:00Z')
    expect(ageFromBirthdate('1997-07-10', now)).toBe(28)
  })

  it('Feb 29 birthdate on a non-leap year counts the birthday as not yet reached until Mar 1', () => {
    // 2027 is not a leap year. On Feb 28, 2027 the birthday hasn't occurred yet.
    const feb28 = new Date('2027-02-28T12:00:00Z')
    expect(ageFromBirthdate('2000-02-29', feb28)).toBe(26)
    const mar1 = new Date('2027-03-01T12:00:00Z')
    expect(ageFromBirthdate('2000-02-29', mar1)).toBe(27)
  })

  it('Feb 29 birthdate on a leap year hits exactly on Feb 29', () => {
    const feb29 = new Date('2028-02-29T12:00:00Z')
    expect(ageFromBirthdate('2000-02-29', feb29)).toBe(28)
  })

  it('returns null for a future birthdate', () => {
    expect(ageFromBirthdate('2099-01-01', NOW)).toBeNull()
  })

  it('returns 0 for a birthdate earlier this year (newborn case)', () => {
    const now = new Date('2026-07-10T12:00:00Z')
    expect(ageFromBirthdate('2026-01-01', now)).toBe(0)
  })

  it('respects a timezone that shifts "today" relative to UTC', () => {
    // 2026-07-10T23:30:00Z is still 2026-07-10 in UTC, but already
    // 2026-07-11 in a timezone ahead of UTC (e.g. Pacific/Auckland, UTC+12).
    // Birthday is 07-11, so in Auckland the birthday has just occurred.
    const lateUtc = new Date('2026-07-10T23:30:00Z')
    expect(ageFromBirthdate('1997-07-11', lateUtc, 'UTC')).toBe(28)
    expect(ageFromBirthdate('1997-07-11', lateUtc, 'Pacific/Auckland')).toBe(29)
  })

  it('falls back to UTC for a null/unrecognized timezone', () => {
    expect(ageFromBirthdate('1997-03-14', NOW, null)).toBe(29)
    expect(ageFromBirthdate('1997-03-14', NOW, 'Not/A_Zone')).toBe(29)
  })
})
