import type { GymTemplate } from '@shared/types'
import { toZonedYMD } from '../../hooks/sessionsDate'

/** "Mon, Jul 7" in the user's timezone (noon-anchored to avoid DST edges). */
export function formatDateShort(iso: string, timezone: string | null | undefined): string {
  const ymd = toZonedYMD(iso, timezone)
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12))
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

/** "6:30 PM" in the user's timezone. */
export function formatTime(iso: string, timezone: string | null | undefined): string {
  const tz = timezone || 'UTC'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso))
}

/** "12" / "7.5" — fractional set counts only show the half. */
export function fmtSets(sets: number): string {
  return Number.isInteger(sets) ? String(sets) : sets.toFixed(1)
}

// Rough per-rep tempo assumption and a small fixed cost per exercise for
// walking to equipment / adjusting a machine — deliberately coarse since this
// is a "~N min" estimate, not a logged duration.
const SECONDS_PER_REP = 3
const SETUP_SECONDS_PER_EXERCISE = 60
const DEFAULT_SETS_WHEN_UNSET = 1
const DEFAULT_REPS_WHEN_UNSET = 10

/**
 * Rough estimated workout duration in seconds: sum over exercises of
 * sets × (reps × ~3s/rep + effective rest-after), plus a small per-exercise
 * setup constant. Exercises without a target_sets/target_reps fall back to a
 * conservative 1×10 so an incomplete template still yields a sane estimate.
 * Deliberately coarse — labeled "~N min" everywhere it's shown, never exact.
 */
export function estimateTemplateDurationSeconds(template: GymTemplate): number {
  let totalSeconds = 0
  for (const item of template.items) {
    const sets = item.target_sets ?? DEFAULT_SETS_WHEN_UNSET
    const reps = item.target_reps ?? DEFAULT_REPS_WHEN_UNSET
    const restSeconds = item.rest_after_s ?? template.default_rest_s ?? 0
    const workSeconds = reps * SECONDS_PER_REP
    totalSeconds += sets * (workSeconds + restSeconds)
    totalSeconds += SETUP_SECONDS_PER_EXERCISE
  }
  return Math.round(totalSeconds)
}

/** "~48 min" — always rounds to the nearest whole minute, minimum "~1 min" when non-empty. */
export function formatEstimatedDuration(totalSeconds: number): string {
  const minutes = Math.max(1, Math.round(totalSeconds / 60))
  return `~${minutes} min`
}
