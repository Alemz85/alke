// Compact per-day workout label for calendar cells: a collapsed activity name +
// duration ("Swim · 44m", "Gym · 1h 45m"). Pure + unit-tested; the calendar cell
// just renders the string. Reuses the cardio-modality map so aerobic names stay
// consistent with the rest of the Zone 2 tab.
import type { Workout } from '@shared/types'
import type { DayBucket } from '../hooks/sessionsCompute'
import { cardioModalityByKey, cardioModalityOf } from './cardioModality'
import { formatDurationHM } from './format'

/**
 * A short, human display name for a workout `type`. Every strength/core variant
 * collapses to a single "Gym" (per the user's ask); cardio types reuse the
 * modality labels (Swim/Cycling/Rowing/Elliptical/Walking); the rest get a
 * best-effort title-case. Substring matching so new Apple type variants slot in
 * without a code change.
 */
export function workoutDisplayName(type: string | null | undefined): string {
  if (!type) return 'Workout'
  const t = type.toLowerCase()
  // Calendar cells use the shorter noun while the Cardio tab uses "Running".
  if (t.includes('run')) return 'Run'
  const cardio = cardioModalityOf(type)
  if (cardio) return cardioModalityByKey(cardio).label
  if (t.includes('strength') || t.includes('core') || t.includes('functional_strength')) return 'Gym'
  if (t.includes('yoga')) return 'Yoga'
  if (t.includes('pilates')) return 'Pilates'
  // Fallback: title-case the raw type ("high_intensity_interval_training" →
  // "High Intensity Interval Training").
  return t
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Duration as the user specified: whole minutes under an hour ("45m"), else
 * hours + minutes ("1h 45m"), with a clean "1h" exactly on the hour.
 * Delegates to lib/format.ts's formatDurationHM — kept as a named export
 * since other files import `formatWorkoutDuration` from here.
 */
export const formatWorkoutDuration = formatDurationHM

/** A day's calendar label, split so the cell can stack name over time. */
export interface CalendarDayLabel {
  /** The longest activity's display name (strength/core → "Gym"). */
  name: string
  /** The day's TOTAL duration ("44m" / "1h 45m"). */
  duration: string
}

/** Does `type` look like a gym workout (strength/core)? Mirrors lib/periodSummary.ts's isGymType. */
function isGymType(type: string | null | undefined): boolean {
  return !!type && /strength|core/.test(type.toLowerCase())
}

/** Does `type` look like cardio (anything but gym/other)? Mirrors lib/periodSummary.ts's isCardioType. */
function isCardioType(type: string | null | undefined): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  return !/strength|core|other/.test(t)
}

/**
 * The bottom-corner calendar label for a day's workouts: the LONGEST workout's
 * display name over the day's TOTAL duration. Returns null for an empty/absent
 * day (no label rendered). For a multi-workout day the longest activity names
 * the cell and the total covers the day — compact by design for a small cell.
 *
 * Exception: when the day mixes at least one gym workout (strength/core) AND
 * at least one cardio workout (anything but gym/other), the name becomes
 * "Gym + Cardio" instead of just the longest activity's name — a mixed day
 * deserves its own label rather than hiding one half of the work.
 */
export function calendarDayLabel(bucket: DayBucket | undefined | null): CalendarDayLabel | null {
  if (!bucket || bucket.workouts.length === 0) return null
  const hasGym = bucket.workouts.some((w) => isGymType(w.type))
  const hasCardio = bucket.workouts.some((w) => isCardioType(w.type))
  if (hasGym && hasCardio) {
    return {
      name: 'Gym + Cardio',
      duration: formatWorkoutDuration(bucket.totalDurationS)
    }
  }
  const longest = bucket.workouts.reduce((best: Workout, w: Workout) =>
    (w.duration_s ?? 0) > (best.duration_s ?? 0) ? w : best
  )
  return {
    name: workoutDisplayName(longest.type),
    duration: formatWorkoutDuration(bucket.totalDurationS)
  }
}
