import { describe, expect, it } from 'vitest'
import type { InjuryLogEntry, PlanItemCheck, RecoveryPlanItem } from '@shared/types'
import {
  adherencePct,
  adherenceRating,
  buildTimeline,
  dailyPainSeries,
  dayScore,
  daysBetween,
  flareStats,
  humanizeDuration,
  isoWeekStart,
  shiftYMD,
  weeklyAdherence,
  weeklyMatrix,
  weeklyProgress
} from '../injuryStats'

// A fixed "now" so all windows are deterministic. 2026-07-10 is a Friday.
const NOW = new Date('2026-07-10T12:00:00Z')
const TODAY = '2026-07-10'

function entry(partial: Partial<InjuryLogEntry> & { entry_date: string }): InjuryLogEntry {
  return {
    id: 1,
    injury_id: 'inj-1',
    noted_at: null,
    source: 'user',
    note: '',
    pain_level: null,
    context: null,
    workout_id: null,
    ...partial
  }
}

function item(partial: Partial<RecoveryPlanItem> & { id: string }): RecoveryPlanItem {
  return {
    injury_id: 'inj-1',
    name: 'Item',
    kind: 'exercise',
    weekly_target: null,
    note: null,
    active: true,
    exercise_id: null,
    created_at: null,
    updated_at: null,
    ...partial
  }
}

function check(itemId: string, doneDate: string, source = 'user'): PlanItemCheck {
  return { id: Math.random(), item_id: itemId, done_date: doneDate, source }
}

// ── date primitives ──────────────────────────────────────────────────────────

describe('daysBetween / shiftYMD', () => {
  it('counts whole days forward and backward', () => {
    expect(daysBetween('2026-07-01', '2026-07-10')).toBe(9)
    expect(daysBetween('2026-07-10', '2026-07-01')).toBe(-9)
    expect(daysBetween('2026-07-10', '2026-07-10')).toBe(0)
  })

  it('crosses month and year boundaries', () => {
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
  })

  it('does not drift across a DST boundary', () => {
    // Late March in most northern-hemisphere zones — pinned to UTC noon so the
    // offset never shortens a day.
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31)
  })

  it('shiftYMD moves by n days', () => {
    expect(shiftYMD('2026-07-10', -30)).toBe('2026-06-10')
    expect(shiftYMD('2026-07-10', 5)).toBe('2026-07-15')
    expect(shiftYMD('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('isoWeekStart', () => {
  it('returns Monday for any weekday', () => {
    // 2026-07-10 is a Friday → week starts Mon 2026-07-06.
    expect(isoWeekStart('2026-07-10')).toBe('2026-07-06')
    expect(isoWeekStart('2026-07-06')).toBe('2026-07-06') // Monday itself
    expect(isoWeekStart('2026-07-12')).toBe('2026-07-06') // Sunday → same week
    expect(isoWeekStart('2026-07-13')).toBe('2026-07-13') // next Monday
  })
})

// ── dailyPainSeries ──────────────────────────────────────────────────────────

describe('dailyPainSeries', () => {
  it('collapses multiple entries on a day to that day-s max pain', () => {
    const entries = [
      entry({ entry_date: '2026-07-10', pain_level: 2 }),
      entry({ entry_date: '2026-07-10', pain_level: 6 }), // later flare same day
      entry({ entry_date: '2026-07-10', pain_level: 4 })
    ]
    expect(dailyPainSeries(entries)).toEqual([{ date: '2026-07-10', pain: 6 }])
  })

  it('treats a fine-then-flare day as a flare day at the flare value', () => {
    // "fine at 18:00, flare at night → flare day"
    const entries = [
      entry({ entry_date: '2026-07-10', pain_level: 0 }),
      entry({ entry_date: '2026-07-10', pain_level: 5 })
    ]
    expect(dailyPainSeries(entries)).toEqual([{ date: '2026-07-10', pain: 5 }])
  })

  it('ignores entries without a pain level and sorts oldest first', () => {
    const entries = [
      entry({ entry_date: '2026-07-12', pain_level: 3 }),
      entry({ entry_date: '2026-07-11', pain_level: null, note: 'AI note' }),
      entry({ entry_date: '2026-07-10', pain_level: 1 })
    ]
    expect(dailyPainSeries(entries)).toEqual([
      { date: '2026-07-10', pain: 1 },
      { date: '2026-07-12', pain: 3 }
    ])
  })
})

// ── flareStats ───────────────────────────────────────────────────────────────

describe('flareStats', () => {
  it('returns nulls for empty entries', () => {
    const s = flareStats([], NOW)
    expect(s.perWeek30d).toBeNull()
    expect(s.avgIntensity30d).toBeNull()
    expect(s.trend).toBeNull()
    expect(s.lastFlare).toBeNull()
  })

  it('reports 0 flares/week when entries exist but none are flares in 30d', () => {
    const s = flareStats([entry({ entry_date: TODAY, pain_level: 0 })], NOW)
    expect(s.perWeek30d).toBe(0)
    expect(s.avgIntensity30d).toBeNull()
    expect(s.lastFlare).toBeNull() // pain 0 is not a flare
  })

  it('counts flare DAYS/week over the 30d window', () => {
    // 3 flare days within last 30 days → 3 / (30/7) = 0.7
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -1), pain_level: 4 }),
      entry({ entry_date: shiftYMD(TODAY, -10), pain_level: 5 }),
      entry({ entry_date: shiftYMD(TODAY, -20), pain_level: 6 })
    ]
    const s = flareStats(entries, NOW)
    expect(s.perWeek30d).toBeCloseTo(3 / (30 / 7), 5)
    expect(s.avgIntensity30d).toBeCloseTo(5, 5)
  })

  it('counts two flares on the same day once, at the day-max', () => {
    // Both on day -1: one flare day, day-max = 7.
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -1), pain_level: 3 }),
      entry({ entry_date: shiftYMD(TODAY, -1), pain_level: 7 })
    ]
    const s = flareStats(entries, NOW)
    expect(s.perWeek30d).toBeCloseTo(1 / (30 / 7), 5)
    expect(s.avgIntensity30d).toBeCloseTo(7, 5)
    expect(s.lastFlare).toEqual({ daysAgo: 1, pain: 7 })
  })

  it('treats a fine+flare same day as a single flare day at the flare value', () => {
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -1), pain_level: 0 }),
      entry({ entry_date: shiftYMD(TODAY, -1), pain_level: 5 })
    ]
    const s = flareStats(entries, NOW)
    expect(s.perWeek30d).toBeCloseTo(1 / (30 / 7), 5)
    expect(s.avgIntensity30d).toBeCloseTo(5, 5)
  })

  it('excludes flares older than 30d from the window but keeps them for lastFlare fallback', () => {
    const entries = [entry({ entry_date: shiftYMD(TODAY, -45), pain_level: 8 })]
    const s = flareStats(entries, NOW)
    expect(s.perWeek30d).toBe(0)
    expect(s.avgIntensity30d).toBeNull()
    expect(s.lastFlare).toEqual({ daysAgo: 45, pain: 8 })
  })

  it('lastFlare picks the most recent flare across all entries', () => {
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -3), pain_level: 2 }),
      entry({ entry_date: shiftYMD(TODAY, -1), pain_level: 7 }),
      entry({ entry_date: shiftYMD(TODAY, -50), pain_level: 9 })
    ]
    const s = flareStats(entries, NOW)
    expect(s.lastFlare).toEqual({ daysAgo: 1, pain: 7 })
  })

  it('trend is null when both windows have < 2 flare entries', () => {
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -5), pain_level: 4 }),
      entry({ entry_date: shiftYMD(TODAY, -40), pain_level: 4 })
    ]
    expect(flareStats(entries, NOW).trend).toBeNull()
  })

  it('trend improving when load drops >15%', () => {
    const entries = [
      // last 30d: load 4
      entry({ entry_date: shiftYMD(TODAY, -2), pain_level: 2 }),
      entry({ entry_date: shiftYMD(TODAY, -5), pain_level: 2 }),
      // prior 30d: load 12
      entry({ entry_date: shiftYMD(TODAY, -35), pain_level: 6 }),
      entry({ entry_date: shiftYMD(TODAY, -40), pain_level: 6 })
    ]
    expect(flareStats(entries, NOW).trend).toBe('improving')
  })

  it('trend worsening when load rises >15%', () => {
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -2), pain_level: 6 }),
      entry({ entry_date: shiftYMD(TODAY, -5), pain_level: 6 }),
      entry({ entry_date: shiftYMD(TODAY, -35), pain_level: 2 }),
      entry({ entry_date: shiftYMD(TODAY, -40), pain_level: 2 })
    ]
    expect(flareStats(entries, NOW).trend).toBe('worsening')
  })

  it('trend stable when load change is within ±15%', () => {
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -2), pain_level: 5 }),
      entry({ entry_date: shiftYMD(TODAY, -5), pain_level: 5 }),
      entry({ entry_date: shiftYMD(TODAY, -35), pain_level: 5 }),
      entry({ entry_date: shiftYMD(TODAY, -40), pain_level: 5 })
    ]
    expect(flareStats(entries, NOW).trend).toBe('stable')
  })

  it('trend worsening when there is current load but no prior load', () => {
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -2), pain_level: 3 }),
      entry({ entry_date: shiftYMD(TODAY, -5), pain_level: 3 })
    ]
    expect(flareStats(entries, NOW).trend).toBe('worsening')
  })

  it('respects the 30d boundary exactly (day -30 is prior, not last)', () => {
    // day -30 falls in the prior window (start30 exclusive), so last-window is empty.
    const entries = [
      entry({ entry_date: shiftYMD(TODAY, -30), pain_level: 5 }),
      entry({ entry_date: shiftYMD(TODAY, -31), pain_level: 5 })
    ]
    const s = flareStats(entries, NOW)
    expect(s.perWeek30d).toBe(0)
  })
})

// ── adherencePct ─────────────────────────────────────────────────────────────

describe('adherencePct', () => {
  it('returns null when no active targeted items', () => {
    expect(adherencePct([], [], TODAY, 7)).toBeNull()
    expect(adherencePct([item({ id: 'a', weekly_target: null })], [], TODAY, 7)).toBeNull()
    expect(
      adherencePct([item({ id: 'a', weekly_target: 3, active: false })], [], TODAY, 7)
    ).toBeNull()
  })

  it('caps per-item score at 100% even when over-done', () => {
    const items = [item({ id: 'a', weekly_target: 3 })]
    const checks = [
      check('a', TODAY),
      check('a', shiftYMD(TODAY, -1)),
      check('a', shiftYMD(TODAY, -2)),
      check('a', shiftYMD(TODAY, -3)),
      check('a', shiftYMD(TODAY, -4))
    ]
    // expected over 7d = 3; done = 5 → min(1, 5/3) = 1 → 100%.
    expect(adherencePct(items, checks, TODAY, 7)).toBe(100)
  })

  it('computes partial adherence and averages across items', () => {
    const items = [item({ id: 'a', weekly_target: 4 }), item({ id: 'b', weekly_target: 2 })]
    const checks = [check('a', TODAY), check('a', shiftYMD(TODAY, -1)), check('b', TODAY)]
    // a: 2/4 = 0.5 ; b: 1/2 = 0.5 → mean 0.5 → 50%.
    expect(adherencePct(items, checks, TODAY, 7)).toBe(50)
  })

  it('excludes checks outside the trailing window', () => {
    const items = [item({ id: 'a', weekly_target: 7 })]
    const checks = [check('a', shiftYMD(TODAY, -8))] // just outside 7d window
    expect(adherencePct(items, checks, TODAY, 7)).toBe(0)
  })

  it('ignores checks for inactive/untargeted items', () => {
    const items = [item({ id: 'a', weekly_target: 2 }), item({ id: 'b', weekly_target: null })]
    const checks = [check('b', TODAY), check('b', TODAY)]
    // Only 'a' counts; it has 0 checks → 0%.
    expect(adherencePct(items, checks, TODAY, 7)).toBe(0)
  })

  it('counts only kind=exercise items — activities and habits are excluded', () => {
    const items = [
      item({ id: 'a', kind: 'exercise', weekly_target: 2 }),
      item({ id: 'b', kind: 'activity', weekly_target: 2 }),
      item({ id: 'c', kind: 'habit', weekly_target: 2 })
    ]
    // 'a' fully met; 'b'/'c' would drag it down if counted, but they are excluded.
    const checks = [check('a', TODAY), check('a', shiftYMD(TODAY, -1))]
    expect(adherencePct(items, checks, TODAY, 7)).toBe(100)
  })
})

// ── dayScore ─────────────────────────────────────────────────────────────────

describe('dayScore', () => {
  it('counts checked exercise items over total active exercise items for a day', () => {
    const items = [
      item({ id: 'a', kind: 'exercise' }),
      item({ id: 'b', kind: 'exercise' }),
      item({ id: 'c', kind: 'exercise' })
    ]
    const checks = [check('a', TODAY), check('b', TODAY), check('a', shiftYMD(TODAY, -1))]
    expect(dayScore(items, checks, TODAY)).toEqual({ done: 2, total: 3 })
  })

  it('excludes activities, habits and constraints from both done and total', () => {
    const items = [
      item({ id: 'a', kind: 'exercise' }),
      item({ id: 'b', kind: 'activity' }),
      item({ id: 'c', kind: 'habit' }),
      item({ id: 'd', kind: 'constraint' })
    ]
    // Checking the activity does not add to done; total stays 1 (only the exercise).
    const checks = [check('b', TODAY), check('a', TODAY)]
    expect(dayScore(items, checks, TODAY)).toEqual({ done: 1, total: 1 })
  })

  it('ignores inactive exercise items', () => {
    const items = [
      item({ id: 'a', kind: 'exercise' }),
      item({ id: 'b', kind: 'exercise', active: false })
    ]
    expect(dayScore(items, [check('a', TODAY)], TODAY)).toEqual({ done: 1, total: 1 })
  })

  it('returns total 0 when there are no active exercise items', () => {
    const items = [item({ id: 'b', kind: 'activity' })]
    expect(dayScore(items, [check('b', TODAY)], TODAY)).toEqual({ done: 0, total: 0 })
  })

  it('counts a check only once even with duplicate check rows', () => {
    const items = [item({ id: 'a', kind: 'exercise' })]
    const checks = [check('a', TODAY), check('a', TODAY)]
    expect(dayScore(items, checks, TODAY)).toEqual({ done: 1, total: 1 })
  })
})

// ── weeklyAdherence ──────────────────────────────────────────────────────────

describe('weeklyAdherence', () => {
  it('returns one entry per ISO week, oldest first, ending on the current week', () => {
    const rows = weeklyAdherence([], [], TODAY, 4)
    expect(rows).toHaveLength(4)
    expect(rows[3].weekStart).toBe(isoWeekStart(TODAY))
    expect(rows[0].weekStart).toBe(shiftYMD(isoWeekStart(TODAY), -21))
    // No targeted items → 0% each.
    expect(rows.every((r) => r.pct === 0)).toBe(true)
  })

  it('scores each week against weekly_target', () => {
    const items = [item({ id: 'a', weekly_target: 2 })]
    const thisWeek = isoWeekStart(TODAY)
    const checks = [check('a', thisWeek), check('a', shiftYMD(thisWeek, 1))]
    const rows = weeklyAdherence(items, checks, TODAY, 2)
    expect(rows[1].pct).toBe(100) // current week: 2/2
    expect(rows[0].pct).toBe(0) // prior week: none
  })
})

// ── weeklyProgress ───────────────────────────────────────────────────────────

describe('weeklyProgress', () => {
  it('returns null without a target', () => {
    expect(weeklyProgress(item({ id: 'a', weekly_target: null }), [], TODAY)).toBeNull()
  })

  it('counts only checks in the current ISO week', () => {
    const it_ = item({ id: 'a', weekly_target: 3 })
    const weekStart = isoWeekStart(TODAY)
    const checks = [
      check('a', weekStart),
      check('a', shiftYMD(weekStart, 2)),
      check('a', shiftYMD(weekStart, -1)) // last week → excluded
    ]
    expect(weeklyProgress(it_, checks, TODAY)).toEqual({ done: 2, target: 3 })
  })
})

// ── adherenceRating ──────────────────────────────────────────────────────────

describe('adherenceRating', () => {
  it('is untargeted when target is null or non-positive, regardless of done', () => {
    expect(adherenceRating(0, null)).toBe('untargeted')
    expect(adherenceRating(5, null)).toBe('untargeted')
    expect(adherenceRating(2, 0)).toBe('untargeted')
  })

  it('is none when done is 0 against a real target', () => {
    expect(adherenceRating(0, 3)).toBe('none')
    expect(adherenceRating(0, 1)).toBe('none')
  })

  it('is low below the 0.75 ratio', () => {
    expect(adherenceRating(1, 2)).toBe('low') // 0.5
    expect(adherenceRating(2, 3)).toBe('low') // 0.667
    expect(adherenceRating(74, 100)).toBe('low') // just below the boundary
  })

  it('is met at exactly 0.75 and above (including over-done)', () => {
    expect(adherenceRating(3, 4)).toBe('met') // exactly 0.75
    expect(adherenceRating(75, 100)).toBe('met')
    expect(adherenceRating(3, 3)).toBe('met')
    expect(adherenceRating(5, 3)).toBe('met')
  })
})

// ── weeklyMatrix ─────────────────────────────────────────────────────────────

describe('weeklyMatrix', () => {
  it('excludes the current week, orders newest first, labels across month boundaries', () => {
    // TODAY 2026-07-10 (Fri) → current week starts Mon 2026-07-06.
    const rows = weeklyMatrix([item({ id: 'a', weekly_target: 3 })], [], TODAY, 2)
    expect(rows).toHaveLength(2)
    expect(rows[0].weekStart).toBe('2026-06-29')
    expect(rows[0].weekEnd).toBe('2026-07-05')
    expect(rows[0].label).toBe('Jun 29 – Jul 5')
    expect(rows[1].weekStart).toBe('2026-06-22')
    expect(rows[1].weekEnd).toBe('2026-06-28')
    expect(rows[1].label).toBe('Jun 22 – Jun 28')
  })

  it('buckets checks into their ISO week and ignores current-week checks', () => {
    const items = [item({ id: 'a', weekly_target: 3 })]
    const checks = [
      check('a', '2026-06-29'), // last week (Mon)
      check('a', '2026-07-05'), // last week (Sun)
      check('a', '2026-07-06'), // current week Monday → excluded
      check('a', '2026-06-28') // week before last (Sun)
    ]
    const rows = weeklyMatrix(items, checks, TODAY, 2)
    expect(rows[0].perItem).toEqual([{ itemId: 'a', done: 2, target: 3 }])
    expect(rows[1].perItem[0].done).toBe(1)
  })

  it('overallPct averages capped ratios across targeted exercise items only', () => {
    const items = [
      item({ id: 'a', kind: 'exercise', weekly_target: 2 }),
      item({ id: 'b', kind: 'exercise', weekly_target: 4 }),
      item({ id: 'c', kind: 'activity', weekly_target: 2 }), // excluded from overall
      item({ id: 'd', kind: 'exercise', weekly_target: null }) // untargeted → excluded
    ]
    const wk = '2026-06-29'
    const checks = [
      // a: 3 checks vs target 2 → capped at 1
      check('a', wk),
      check('a', shiftYMD(wk, 1)),
      check('a', shiftYMD(wk, 2)),
      // b: 1/4 = 0.25
      check('b', wk),
      // c: activity checks must not affect the overall
      check('c', wk),
      check('c', shiftYMD(wk, 1))
    ]
    const rows = weeklyMatrix(items, checks, TODAY, 1)
    expect(rows[0].overallPct).toBe(63) // (1 + 0.25) / 2 = 0.625 → 63
    // per-item counts still reported for every active item, in input order
    expect(rows[0].perItem).toEqual([
      { itemId: 'a', done: 3, target: 2 },
      { itemId: 'b', done: 1, target: 4 },
      { itemId: 'c', done: 2, target: 2 },
      { itemId: 'd', done: 0, target: null }
    ])
  })

  it('overallPct is null when no targeted exercise items exist', () => {
    const items = [item({ id: 'c', kind: 'activity', weekly_target: 2 })]
    const rows = weeklyMatrix(items, [check('c', '2026-06-29')], TODAY, 1)
    expect(rows[0].overallPct).toBeNull()
    expect(rows[0].perItem[0].done).toBe(1)
  })

  it('skips inactive items entirely', () => {
    const rows = weeklyMatrix([item({ id: 'a', weekly_target: 2, active: false })], [], TODAY, 1)
    expect(rows[0].perItem).toEqual([])
    expect(rows[0].overallPct).toBeNull()
  })
})

// ── buildTimeline ────────────────────────────────────────────────────────────

describe('buildTimeline', () => {
  it('merges notes and checks by date, newest first', () => {
    const items = [item({ id: 'a', name: 'Calf raises' })]
    const entries = [
      entry({ id: 1, entry_date: '2026-07-08', note: 'sore' }),
      entry({ id: 2, entry_date: '2026-07-10', note: 'better' })
    ]
    const checks = [check('a', '2026-07-10'), check('a', '2026-07-09')]
    const timeline = buildTimeline(entries, checks, items)
    expect(timeline.map((d) => d.date)).toEqual(['2026-07-10', '2026-07-09', '2026-07-08'])
    expect(timeline[0].notes).toHaveLength(1)
    expect(timeline[0].checks).toEqual([{ itemName: 'Calf raises', source: 'user' }])
    expect(timeline[1].notes).toHaveLength(0)
    expect(timeline[1].checks).toHaveLength(1)
  })

  it('falls back to the raw item id when the item is unknown', () => {
    const timeline = buildTimeline([], [check('ghost', '2026-07-10')], [])
    expect(timeline[0].checks[0].itemName).toBe('ghost')
  })

  it('returns an empty array for no data', () => {
    expect(buildTimeline([], [], [])).toEqual([])
  })
})

// ── humanizeDuration ─────────────────────────────────────────────────────────

describe('humanizeDuration', () => {
  it('returns — for null or inverted ranges', () => {
    expect(humanizeDuration(null, TODAY)).toBe('—')
    expect(humanizeDuration(TODAY, null)).toBe('—')
    expect(humanizeDuration('2026-07-10', '2026-07-01')).toBe('—')
  })

  it('formats days under a month', () => {
    expect(humanizeDuration('2026-07-01', '2026-07-13')).toBe('12 d')
    expect(humanizeDuration('2026-07-10', '2026-07-10')).toBe('0 d')
  })

  it('formats months', () => {
    expect(humanizeDuration('2026-01-01', '2026-04-01')).toBe('3 mo')
  })

  it('formats years with a decimal, dropping trailing .0', () => {
    expect(humanizeDuration('2025-01-01', '2026-01-01')).toBe('1 y')
    expect(humanizeDuration('2024-07-01', '2026-01-01')).toBe('1.5 y')
  })
})
