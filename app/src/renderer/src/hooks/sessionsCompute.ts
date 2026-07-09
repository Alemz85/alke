// Pure aggregation helpers for the Sessions tab: grouping workouts by local
// calendar day/week, and computing the longest streak of consecutive ISO
// weeks meeting the configured weekly minimums. Kept separate from the data
// hooks so the math is trivially unit-testable / reviewable in isolation.
import type { Workout } from '@shared/types'
import { workoutMatchesGoal } from '../lib/modality'
import { isoWeekKey, localDateKey, toZonedYMD } from './sessionsDate'

export interface DayBucket {
  dateKey: string
  workouts: Workout[]
  totalDurationS: number
  modalities: string[] // unique, in first-seen order
}

/** Group workouts by their LOCAL calendar date (per DESIGN.md's timezone rule). */
export function groupWorkoutsByDay(
  workouts: Workout[],
  timezone: string | null | undefined
): Map<string, DayBucket> {
  const map = new Map<string, DayBucket>()
  for (const w of workouts) {
    const dateKey = localDateKey(w.start_at, timezone)
    let bucket = map.get(dateKey)
    if (!bucket) {
      bucket = { dateKey, workouts: [], totalDurationS: 0, modalities: [] }
      map.set(dateKey, bucket)
    }
    bucket.workouts.push(w)
    bucket.totalDurationS += w.duration_s ?? 0
    const type = w.type?.toLowerCase() ?? 'other'
    if (!bucket.modalities.includes(type)) bucket.modalities.push(type)
  }
  return map
}

/** Duration step thresholds (seconds) for the heatmap cell color scale. */
export const DURATION_STEPS = [
  { maxS: 30 * 60, label: '<30m' },
  { maxS: 60 * 60, label: '30-60m' },
  { maxS: 90 * 60, label: '60-90m' },
  { maxS: Infinity, label: '>90m' }
] as const

/** Map a total-duration-for-day (seconds) to a step index 0..3 (0 = shortest). */
export function durationStepIndex(totalDurationS: number): number {
  for (let i = 0; i < DURATION_STEPS.length; i++) {
    if (totalDurationS <= DURATION_STEPS[i].maxS) return i
  }
  return DURATION_STEPS.length - 1
}

/** Group workouts by ISO week key ("YYYY-Www"), counting sessions per modality-type bucket "any". */
function groupWorkoutsByIsoWeek(
  workouts: Workout[],
  timezone: string | null | undefined
): Map<string, Workout[]> {
  const map = new Map<string, Workout[]>()
  for (const w of workouts) {
    const ymd = toZonedYMD(w.start_at, timezone)
    const wk = isoWeekKey(ymd)
    const list = map.get(wk)
    if (list) list.push(w)
    else map.set(wk, [w])
  }
  return map
}

/**
 * Does the given week's workouts meet weekly_min_sessions? The config maps
 * modality -> minimum count (e.g. {"swim": 2, "lift": 2}). A week "meets" the
 * bar when every configured modality reaches its minimum count that week.
 * If no minimums are configured, falls back to "at least 1 session".
 */
function weekMeetsMinimums(
  weekWorkouts: Workout[],
  weeklyMin: Record<string, unknown> | null | undefined
): boolean {
  const entries = weeklyMin ? Object.entries(weeklyMin) : []
  if (entries.length === 0) {
    return weekWorkouts.length > 0
  }
  return entries.every(([modality, min]) => {
    const minNum = typeof min === 'number' ? min : Number(min)
    if (!Number.isFinite(minNum) || minNum <= 0) return true
    const count = weekWorkouts.filter((w) => workoutMatchesGoal(w.type, modality)).length
    return count >= minNum
  })
}

/**
 * Longest streak of consecutive ISO weeks (Mon-start) meeting
 * weekly_min_sessions, across all loaded workout history. Returns the streak
 * length in weeks. Weeks with zero data (no workouts loaded at all for that
 * week) break the streak, same as a week that fails the minimum.
 */
export function longestWeeklyStreak(
  workouts: Workout[],
  weeklyMin: Record<string, unknown> | null | undefined,
  timezone: string | null | undefined
): number {
  if (workouts.length === 0) return 0
  const byWeek = groupWorkoutsByIsoWeek(workouts, timezone)

  // Build the ordered list of ISO week keys spanning the earliest to latest
  // workout, so gaps (weeks with zero sessions) are represented as failures
  // rather than silently skipped.
  const sortedKeys = Array.from(byWeek.keys()).sort()
  if (sortedKeys.length === 0) return 0

  const [firstYear, firstWeek] = parseIsoWeekKey(sortedKeys[0])
  const [lastYear, lastWeek] = parseIsoWeekKey(sortedKeys[sortedKeys.length - 1])

  let longest = 0
  let current = 0
  let y = firstYear
  let w = firstWeek
  // Cap iterations generously (a year of weeks + margin) to avoid any risk of
  // infinite loop from malformed data.
  for (let i = 0; i < 600; i++) {
    const key = `${y}-W${w.toString().padStart(2, '0')}`
    const weekWorkouts = byWeek.get(key) ?? []
    if (weekMeetsMinimums(weekWorkouts, weeklyMin)) {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
    if (y === lastYear && w === lastWeek) break
    const weeksInYear = isoWeeksInYear(y)
    if (w >= weeksInYear) {
      w = 1
      y += 1
    } else {
      w += 1
    }
  }
  return longest
}

function parseIsoWeekKey(key: string): [number, number] {
  const [yearStr, weekStr] = key.split('-W')
  return [Number(yearStr), Number(weekStr)]
}

function isoWeeksInYear(year: number): number {
  // A year has 53 ISO weeks iff Jan 1 or Dec 31 falls on a Thursday.
  const p = (y: number): number => (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)) % 7
  return p(year) === 4 || p(year - 1) === 3 ? 53 : 52
}

export function formatDuration(totalS: number): string {
  const totalMin = Math.round(totalS / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  return `${h}:${m.toString().padStart(2, '0')}`
}
