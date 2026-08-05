import type { GymTemplate, GymTemplateItem } from '@shared/types'
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

/** "45s" / "1:30" — a prescribed hold, minutes only once it's worth reading as one. */
export function formatDoseDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * The dose half of a template line: "3 × 8" for reps, "3 × 45s" for a hold, and
 * an em dash for whichever side is unset. A template item carries ONE dose
 * measure (DB constraint), so this never has to show both — and a timed item
 * must never render as "× 1", which is what made holds unrepresentable before
 * target_duration_seconds existed.
 */
export function formatTemplateDose(
  item: Pick<GymTemplateItem, 'target_sets' | 'target_reps' | 'target_duration_seconds'>,
  options: { compact?: boolean } = {}
): string {
  const sets = item.target_sets != null ? fmtSets(item.target_sets) : '—'
  const dose =
    item.target_duration_seconds != null
      ? formatDoseDuration(item.target_duration_seconds)
      : item.target_reps != null
        ? String(item.target_reps)
        : '—'
  // Cards run tight on width, so they get the unspaced "3×8"; the modal has
  // room for the spaced form.
  return options.compact ? `${sets}×${dose}` : `${sets} × ${dose}`
}

/** True when the line prescribes neither reps nor a duration nor a set count. */
export function hasNoTemplateTarget(
  item: Pick<GymTemplateItem, 'target_sets' | 'target_reps' | 'target_duration_seconds'>
): boolean {
  return item.target_sets == null && item.target_reps == null && item.target_duration_seconds == null
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
 * sets × (work + effective rest-after), plus a small per-exercise setup
 * constant. Work is the prescribed hold for a timed item, else reps × ~3s/rep.
 * Exercises without any target fall back to a conservative 1×10 so an
 * incomplete template still yields a sane estimate. Deliberately coarse —
 * labeled "~N min" everywhere it's shown, never exact.
 */
export function estimateTemplateDurationSeconds(template: GymTemplate): number {
  let totalSeconds = 0
  for (const item of template.items) {
    const sets = item.target_sets ?? DEFAULT_SETS_WHEN_UNSET
    const restSeconds = item.rest_after_s ?? template.default_rest_s ?? 0
    const workSeconds =
      item.target_duration_seconds ?? (item.target_reps ?? DEFAULT_REPS_WHEN_UNSET) * SECONDS_PER_REP
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
