import type { Domain } from './domain'

// Single exported mapping of workout modality -> domain accent, per the
// calendar-heatmap spec in DESIGN.md: "decide a modality -> accent mapping
// and put it in ONE exported constant." Domain colors are semantic (not
// modality-decorative), so this maps each modality to the *health-system*
// domain it best represents:
//   swim / elliptical / cycling -> aerobic (cardio work)
//   strength / lifting          -> load (training load / resistance)
//   surfing                     -> sessions (the catch-all adherence domain)
//   walking / other             -> text-tertiary (neutral, not domain data)
export const MODALITY_DOMAIN: Record<string, Domain | 'neutral'> = {
  swim: 'aerobic',
  swimming: 'aerobic',
  elliptical: 'aerobic',
  cycling: 'aerobic',
  bike: 'aerobic',
  cycle: 'aerobic',
  run: 'aerobic',
  running: 'aerobic',
  strength: 'load',
  lifting: 'load',
  weights: 'load',
  weight_training: 'load',
  surf: 'sessions',
  surfing: 'sessions',
  walking: 'neutral',
  walk: 'neutral',
  other: 'neutral'
}

/** Resolve a workout `type` string to its domain (or 'neutral'), defaulting unknown types to neutral. */
export function modalityToDomain(type: string): Domain | 'neutral' {
  return MODALITY_DOMAIN[type.toLowerCase()] ?? 'neutral'
}

// Environment classification (water / indoor / outdoor) lives in lib/modality.ts
// so pure stat helpers (periodSummary visit merging) can share it; re-exported
// here because components historically import it from this module.
import { activityEnvironment } from '../lib/modality'
import { cardioModalityByKey, cardioModalityOf } from '../lib/cardioModality'

export { activityEnvironment, type ActivityEnvironment } from '../lib/modality'

/** The environment accent CSS var (water=blue, indoor=orange, outdoor=green). */
export function activityEnvironmentAccent(type: string): string {
  return `var(--color-env-${activityEnvironment(type)})`
}

/**
 * Human-readable label for a single workout, used in lists and the day drawer.
 * Every strength/core variant collapses to a single "Gym" (per the owner's ask
 * — "all kinds of strength training renamed to just Gym"); every other type
 * keeps its specific title-cased name ("Pool Swim", "Indoor Cycling") so the
 * row/detail stays informative.
 */
export function modalityLabel(type: string): string {
  if (!type) return 'Unknown'
  if (/strength|core/i.test(type)) return 'Gym'
  return type
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * The coarser ACTIVITY GROUP a workout belongs to — the label used by the
 * Sessions filter dropdown and by cross-view navigation (a cardio "recent
 * sessions" card jumps to Sessions filtered to its group). Strength/core →
 * "Gym"; cardio types collapse to their modality family ("Swim" covers pool +
 * open-water, "Running" covers treadmill + outdoor, etc.) so one option matches
 * every variant. Matches `cardioModalityByKey(key).label` exactly, so a modality
 * card can pass its label straight through as the filter value.
 */
export function activityGroupLabel(type: string): string {
  if (!type) return 'Other'
  if (/strength|core/i.test(type)) return 'Gym'
  const cardio = cardioModalityOf(type)
  if (cardio) return cardioModalityByKey(cardio).label
  return modalityLabel(type)
}
