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

/** Human-readable label for a modality, used in the drawer and stat table. */
export function modalityLabel(type: string): string {
  if (!type) return 'Unknown'
  return type
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
