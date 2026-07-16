import type { Domain } from './domain'
// Environment classification (water / indoor / outdoor) lives in lib/modality.ts
// so pure stat helpers (periodSummary visit merging) can share it; re-exported
// here because components historically import it from this module.
import { activityEnvironment } from '../lib/modality'
import { cardioModalityByKey, cardioModalityOf } from '../lib/cardioModality'

// Single exported mapping of workout modality -> domain accent, per the
// calendar-heatmap spec in DESIGN.md: "decide a modality -> accent mapping
// and put it in ONE exported constant." Domain colors are semantic (not
// modality-decorative), so this maps each modality to the *health-system*
// domain it best represents:
//   swim / elliptical / cycling / running -> aerobic (cardio work)
//   strength / lifting / core             -> load (training load / resistance)
//   surfing                               -> sessions (the catch-all adherence domain)
//   walking / other                       -> text-tertiary (neutral, not domain data)
//
// Kept as an exact-match table of the short/legacy tokens for direct lookups
// elsewhere, but modalityToDomain (below) does NOT rely on this alone: real
// Apple Health ingest types are compound strings like
// "functional_strength_training" / "traditional_strength_training" that
// never appear verbatim here, so an exact match against this table silently
// fell through to 'neutral' for every real strength workout (confirmed
// symptom: DayDetailDrawer showed a strength day labeled "Gym" — via
// modalityLabel's regex below — but tinted neutral instead of 'load').
// modalityToDomain instead reuses the SAME classification cardioModalityOf /
// modalityLabel already use, so a type is either a tracked cardio modality
// (aerobic), strength/core (load, matching modalityLabel's "Gym" regex), or
// falls through to this table / neutral.
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

/**
 * Resolve a workout `type` string to its domain (or 'neutral'). Checks, in
 * order: the exact-match table above for its explicit overrides (walking ->
 * neutral, surf -> sessions — walking/hiking ARE a tracked cardioModalityOf
 * family for the Zone 2 switcher, but deliberately NOT an "aerobic"-accented
 * domain here, per the table's original design); a tracked cardio modality
 * otherwise (aerobic — covers every real cardio ingest variant via
 * cardioModalityOf's substring matching, not just the short tokens in
 * MODALITY_DOMAIN, e.g. "open_water_swim", "treadmill_running"); strength/
 * core (load — the exact same regex modalityLabel uses to render "Gym", so
 * the accent and the label never disagree); neutral as the final default.
 */
export function modalityToDomain(type: string): Domain | 'neutral' {
  const exact = MODALITY_DOMAIN[type.toLowerCase()]
  if (exact !== undefined) return exact
  if (cardioModalityOf(type)) return 'aerobic'
  if (/strength|core/i.test(type)) return 'load'
  return 'neutral'
}

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
