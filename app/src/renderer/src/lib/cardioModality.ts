// Cardio modality model for the Zone 2 tab's per-modality navigation.
//
// A "cardio modality" groups the concrete Apple Health workout `type` strings
// (e.g. "pool_swim", "indoor_cycling") into the handful of aerobic families the
// app tracks. Strength / core / other types are NOT cardio and map to
// null — they never appear in the modality switcher.
//
// Matching is substring-based on the lowercased type so new variants Apple adds
// (open_water_swim, mixed_cardio biking, hiking...) fall into the right family
// without a code change.

export type CardioModalityKey = 'swim' | 'cycling' | 'rowing' | 'elliptical' | 'walking'

export interface CardioModality {
  key: CardioModalityKey
  /** Display label for headings and chips. */
  label: string
  /** Substrings matched (case-insensitively) against the workout `type`. */
  match: readonly string[]
}

// Ordered — this is also the switcher's chip order after Summary.
export const CARDIO_MODALITIES: readonly CardioModality[] = [
  { key: 'swim', label: 'Swim', match: ['swim'] },
  { key: 'cycling', label: 'Cycling', match: ['cycling', 'biking'] },
  { key: 'rowing', label: 'Rowing', match: ['rowing'] },
  { key: 'elliptical', label: 'Elliptical', match: ['elliptical'] },
  { key: 'walking', label: 'Walking', match: ['walk', 'hiking'] }
] as const

/**
 * Resolve a workout `type` to its cardio modality key, or `null` when the type
 * is not a tracked cardio modality (strength, core, other, unknown).
 */
export function cardioModalityOf(type: string | null | undefined): CardioModalityKey | null {
  if (!type) return null
  const t = type.toLowerCase()
  for (const m of CARDIO_MODALITIES) {
    if (m.match.some((s) => t.includes(s))) return m.key
  }
  return null
}

/** Look up the modality definition (label + match) by key. */
export function cardioModalityByKey(key: CardioModalityKey): CardioModality {
  const m = CARDIO_MODALITIES.find((x) => x.key === key)
  // key is a CardioModalityKey, so this is always defined.
  return m as CardioModality
}
