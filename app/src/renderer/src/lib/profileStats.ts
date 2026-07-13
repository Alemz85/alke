// Pure, testable analytics for the Profile tab: lifetime stats, achievement
// badges, and goal-progress helpers. Same discipline as injuryStats.ts — every
// function takes an explicit `now: Date`, no Date.now() inside, dates handled
// as YYYY-MM-DD strings compared lexicographically where possible.

import type { Goal, GoalProgressPoint, Workout } from '@shared/types'
import { cardioModalityOf } from './cardioModality'

// ── date primitives (mirrors injuryStats.ts) ────────────────────────────────

function parseYMD(s: string): Date {
  const ymd = s.slice(0, 10)
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0))
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Monday of the ISO week containing `ymd`, as a YMD string. */
function isoWeekStart(ymd: string): string {
  const d = parseYMD(ymd)
  const dow = (d.getUTCDay() + 6) % 7 // 0=Mon..6=Sun
  d.setUTCDate(d.getUTCDate() - dow)
  return toYMD(d)
}

function shiftYMD(ymd: string, n: number): string {
  const d = parseYMD(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return toYMD(d)
}

/** Whole days between two YMD strings (b - a). */
function daysBetween(aYMD: string, bYMD: string): number {
  const a = parseYMD(aYMD).getTime()
  const b = parseYMD(bYMD).getTime()
  return Math.round((b - a) / 86_400_000)
}

function isSwim(w: Workout): boolean {
  return cardioModalityOf(w.type) === 'swim'
}

// ── lifetime stats ───────────────────────────────────────────────────────────

export interface ProfileStats {
  workoutCount: number
  totalHours: number
  totalSwimKm: number
  activeWeeks: number
  currentStreakWeeks: number
  longestStreakWeeks: number
  /** Date (YMD) of the earliest workout, or null with no workouts. */
  trackingSince: string | null
}

/**
 * Lifetime rollups across all workouts. Streaks count consecutive ISO weeks
 * (Mon-start) with >= 1 workout; the current streak only counts if the most
 * recent active week is THIS week or LAST week (a gap of one week still reads
 * as "current" — anything older is a broken streak, reported as 0).
 */
export function profileStats(workouts: Workout[], now: Date): ProfileStats {
  const workoutCount = workouts.length

  let totalSeconds = 0
  let totalSwimM = 0
  for (const w of workouts) {
    totalSeconds += w.duration_s ?? 0
    if (isSwim(w) && w.distance_m != null) totalSwimM += w.distance_m
  }
  const totalHours = totalSeconds / 3600
  const totalSwimKm = totalSwimM / 1000

  if (workoutCount === 0) {
    return {
      workoutCount: 0,
      totalHours: 0,
      totalSwimKm: 0,
      activeWeeks: 0,
      currentStreakWeeks: 0,
      longestStreakWeeks: 0,
      trackingSince: null
    }
  }

  const weekSet = new Set<string>()
  let earliest: string | null = null
  for (const w of workouts) {
    const ymd = w.start_at.slice(0, 10)
    if (earliest == null || ymd < earliest) earliest = ymd
    weekSet.add(isoWeekStart(ymd))
  }
  const activeWeeks = weekSet.size

  // Longest and current streaks over the sorted set of active week-starts.
  const sortedWeeks = Array.from(weekSet).sort()
  let longestStreakWeeks = 1
  let run = 1
  for (let i = 1; i < sortedWeeks.length; i++) {
    const prevPlus7 = shiftYMD(sortedWeeks[i - 1], 7)
    if (sortedWeeks[i] === prevPlus7) {
      run += 1
    } else {
      run = 1
    }
    if (run > longestStreakWeeks) longestStreakWeeks = run
  }

  const nowYMD = toYMD(now)
  const thisWeekStart = isoWeekStart(nowYMD)
  const lastWeekStart = shiftYMD(thisWeekStart, -7)
  const newestActiveWeek = sortedWeeks[sortedWeeks.length - 1]

  let currentStreakWeeks = 0
  if (newestActiveWeek === thisWeekStart || newestActiveWeek === lastWeekStart) {
    // Walk backward from the newest active week while consecutive.
    let cursor = newestActiveWeek
    let count = 0
    const weekSetLookup = weekSet
    while (weekSetLookup.has(cursor)) {
      count += 1
      cursor = shiftYMD(cursor, -7)
    }
    currentStreakWeeks = count
  }

  return {
    workoutCount,
    totalHours,
    totalSwimKm,
    activeWeeks,
    currentStreakWeeks,
    longestStreakWeeks,
    trackingSince: earliest
  }
}

// ── achievements ─────────────────────────────────────────────────────────────

export interface Achievement {
  id: string
  title: string
  description: string
  earned: boolean
  /** YMD of the workout that crossed the threshold, when earned. */
  earnedDate?: string
}

interface Milestone {
  id: string
  title: string
  description: string
}

const WORKOUT_COUNT_MILESTONES: Array<Milestone & { count: number }> = [
  { id: 'workouts-1', count: 1, title: 'First workout', description: 'Logged your first workout.' },
  { id: 'workouts-10', count: 10, title: '10 workouts', description: 'Ten workouts logged.' },
  { id: 'workouts-50', count: 50, title: '50 workouts', description: 'Fifty workouts logged.' },
  { id: 'workouts-100', count: 100, title: '100 workouts', description: 'A hundred workouts logged.' },
  { id: 'workouts-250', count: 250, title: '250 workouts', description: 'Two hundred fifty workouts logged.' }
]

const HOURS_MILESTONES: Array<Milestone & { hours: number }> = [
  { id: 'hours-10', hours: 10, title: '10 hours', description: 'Ten hours of training time.' },
  { id: 'hours-50', hours: 50, title: '50 hours', description: 'Fifty hours of training time.' },
  { id: 'hours-100', hours: 100, title: '100 hours', description: 'A hundred hours of training time.' }
]

const SWIM_KM_MILESTONES: Array<Milestone & { km: number }> = [
  { id: 'swim-first', km: 0, title: 'First swim', description: 'Logged your first swim.' },
  { id: 'swim-10', km: 10, title: '10 km swum', description: 'Ten kilometers swum, lifetime.' },
  { id: 'swim-25', km: 25, title: '25 km swum', description: 'Twenty-five kilometers swum, lifetime.' },
  { id: 'swim-50', km: 50, title: '50 km swum', description: 'Fifty kilometers swum, lifetime.' },
  { id: 'swim-100', km: 100, title: '100 km swum', description: 'A hundred kilometers swum, lifetime.' }
]

const STREAK_MILESTONES: Array<Milestone & { weeks: number }> = [
  { id: 'streak-4', weeks: 4, title: '4-week streak', description: 'A workout every week for four weeks running.' },
  { id: 'streak-8', weeks: 8, title: '8-week streak', description: 'A workout every week for eight weeks running.' },
  { id: 'streak-12', weeks: 12, title: '12-week streak', description: 'A workout every week for twelve weeks running.' }
]

/**
 * Milestone ladder derived from the same workout data as profileStats. Each
 * achievement's earnedDate is the date of the workout that first crossed the
 * threshold (chronological accumulation order, not necessarily the newest
 * workout). Unearned achievements carry no earnedDate.
 */
export function achievements(workouts: Workout[], now: Date): Achievement[] {
  const sorted = [...workouts].sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0))

  const out: Achievement[] = []

  // -- workout count ladder --
  for (const m of WORKOUT_COUNT_MILESTONES) {
    const w = sorted[m.count - 1]
    out.push(toAchievement(m, w))
  }

  // -- cumulative hours ladder --
  let cumHours = 0
  const hourDates = new Map<string, string>()
  for (const w of sorted) {
    cumHours += (w.duration_s ?? 0) / 3600
    for (const m of HOURS_MILESTONES) {
      if (!hourDates.has(m.id) && cumHours >= m.hours) hourDates.set(m.id, w.start_at.slice(0, 10))
    }
  }
  for (const m of HOURS_MILESTONES) {
    const date = hourDates.get(m.id)
    out.push(date ? { ...m, earned: true, earnedDate: date } : { ...m, earned: false })
  }

  // -- cumulative swim km ladder --
  let cumSwimKm = 0
  const swimDates = new Map<string, string>()
  for (const w of sorted) {
    if (!isSwim(w) || w.distance_m == null) continue
    cumSwimKm += w.distance_m / 1000
    for (const m of SWIM_KM_MILESTONES) {
      if (!swimDates.has(m.id) && cumSwimKm >= m.km) swimDates.set(m.id, w.start_at.slice(0, 10))
    }
  }
  for (const m of SWIM_KM_MILESTONES) {
    const date = swimDates.get(m.id)
    out.push(date ? { ...m, earned: true, earnedDate: date } : { ...m, earned: false })
  }

  // -- streak ladder: walk ISO weeks in order, track running streak length --
  const weekSet = new Set<string>()
  const firstWorkoutOfWeek = new Map<string, string>()
  for (const w of sorted) {
    const ymd = w.start_at.slice(0, 10)
    const wk = isoWeekStart(ymd)
    weekSet.add(wk)
    if (!firstWorkoutOfWeek.has(wk)) firstWorkoutOfWeek.set(wk, ymd)
  }
  const sortedWeeks = Array.from(weekSet).sort()
  const streakDates = new Map<string, string>()
  let run = 0
  let prevWeek: string | null = null
  for (const wk of sortedWeeks) {
    if (prevWeek != null && wk === shiftYMD(prevWeek, 7)) {
      run += 1
    } else {
      run = 1
    }
    prevWeek = wk
    for (const m of STREAK_MILESTONES) {
      if (!streakDates.has(m.id) && run >= m.weeks) {
        // Earned on the last workout's week that completed the streak — use
        // that week's first workout date.
        streakDates.set(m.id, firstWorkoutOfWeek.get(wk) as string)
      }
    }
  }
  for (const m of STREAK_MILESTONES) {
    const date = streakDates.get(m.id)
    out.push(date ? { ...m, earned: true, earnedDate: date } : { ...m, earned: false })
  }

  // -- single-session milestones --
  const first60min = sorted.find((w) => (w.duration_s ?? 0) >= 60 * 60)
  out.push(
    first60min
      ? {
          id: 'session-60min',
          title: 'First 60-min session',
          description: 'A single workout of an hour or more.',
          earned: true,
          earnedDate: first60min.start_at.slice(0, 10)
        }
      : {
          id: 'session-60min',
          title: 'First 60-min session',
          description: 'A single workout of an hour or more.',
          earned: false
        }
  )

  const first2kmSwim = sorted.find((w) => isSwim(w) && (w.distance_m ?? 0) >= 2000)
  out.push(
    first2kmSwim
      ? {
          id: 'session-2km-swim',
          title: 'First 2 km swim',
          description: 'A single swim of two kilometers or more.',
          earned: true,
          earnedDate: first2kmSwim.start_at.slice(0, 10)
        }
      : {
          id: 'session-2km-swim',
          title: 'First 2 km swim',
          description: 'A single swim of two kilometers or more.',
          earned: false
        }
  )

  // now is accepted for interface symmetry with profileStats/future date-relative
  // badges, but the current ladder is purely cumulative — silence unused warnings.
  void now

  return out
}

function toAchievement(m: Milestone, w: Workout | undefined): Achievement {
  return w ? { ...m, earned: true, earnedDate: w.start_at.slice(0, 10) } : { ...m, earned: false }
}

// ── goal helpers ─────────────────────────────────────────────────────────────

export interface TimeProgress {
  elapsedDays: number
  /** null when the goal is open-ended (no duration_days). */
  pct: number | null
}

/** Elapsed time since a goal started, and % of its duration elapsed (open-ended → null). */
export function timeProgress(goal: Goal, now: Date): TimeProgress {
  const nowYMD = toYMD(now)
  const elapsedDays = Math.max(0, daysBetween(goal.started_at.slice(0, 10), nowYMD))
  if (goal.duration_days == null || goal.duration_days <= 0) {
    return { elapsedDays, pct: null }
  }
  const pct = Math.max(0, Math.min(100, Math.round((elapsedDays / goal.duration_days) * 100)))
  return { elapsedDays, pct }
}

/**
 * "Active for N days · since {date}" / "On hold since {date}" / "{Completed|
 * Abandoned} {date}" — the goal card's status meta line. Anchors on
 * `status_changed_at` (falls back to `started_at` when null, e.g. a goal that
 * has never changed status since creation). Returns the anchor YMD alongside
 * the label so callers can format the date with their own formatter.
 */
export interface SinceLabel {
  text: string
  /** YMD the label is anchored on — callers append their own date formatting. */
  anchorYMD: string
}

export function sinceLabel(goal: Goal, now: Date): SinceLabel {
  const anchor = (goal.status_changed_at ?? goal.started_at).slice(0, 10)
  const nowYMD = toYMD(now)
  const days = Math.max(0, daysBetween(anchor, nowYMD))

  if (goal.status === 'active') {
    return { text: `Active for ${days} day${days === 1 ? '' : 's'} · since`, anchorYMD: anchor }
  }
  if (goal.status === 'on_hold') {
    return { text: 'On hold since', anchorYMD: anchor }
  }
  const verb = goal.status === 'completed' ? 'Completed' : 'Abandoned'
  return { text: verb, anchorYMD: anchor }
}

export interface MetricProgress {
  latest: number | null
  /** Signed change vs baseline, direction-aware sign not applied (raw delta: latest - baseline). */
  delta: number | null
  /** 0-100, direction-aware, only when baseline AND target are present. */
  pctToTarget: number | null
}

/**
 * Progress of a goal's metric series toward its target, direction-aware:
 * 'up' goals treat higher-than-baseline as progress; 'down' goals treat
 * lower-than-baseline as progress. pctToTarget is null unless both baseline
 * and target are set (and target != baseline, avoiding a divide-by-zero).
 */
export function metricProgress(goal: Goal, points: GoalProgressPoint[]): MetricProgress {
  if (points.length === 0) {
    return { latest: null, delta: null, pctToTarget: null }
  }
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const latest = sorted[sorted.length - 1].value

  const baseline = goal.metric_baseline
  const delta = baseline != null ? latest - baseline : null

  let pctToTarget: number | null = null
  if (baseline != null && goal.metric_target != null && goal.metric_target !== baseline) {
    const raw = (latest - baseline) / (goal.metric_target - baseline)
    pctToTarget = Math.max(0, Math.min(100, Math.round(raw * 100)))
  }

  return { latest, delta, pctToTarget }
}
