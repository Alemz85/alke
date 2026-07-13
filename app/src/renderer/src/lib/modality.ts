// Maps weekly_min_sessions goal keys (e.g. "swim", "lift") onto concrete
// workout types reported by Apple Health (e.g. "pool_swim",
// "functional_strength_training"), which never match the goal keys literally.

const GOAL_SYNONYMS: Record<string, string[]> = {
  lift: ['strength', 'weight'],
  swim: ['swim'],
  bike: ['cycling', 'biking'],
  row: ['rowing'],
  cardio: ['swim', 'cycling', 'elliptical', 'rowing']
}

export function workoutMatchesGoal(workoutType: string | null, goalKey: string): boolean {
  if (!workoutType) return false
  const type = workoutType.toLowerCase()
  const goal = goalKey.toLowerCase()
  if (type.includes(goal)) return true
  return (GOAL_SYNONYMS[goal] ?? []).some((s) => type.includes(s))
}

/**
 * The SETTING a workout happens in — water (pool/open water), indoor
 * (gym floor, ergs, studio classes), or outdoor (roads/trails, the fallback).
 * Distinct from the training domain: an indoor row and a strength session
 * share an environment even though one is cardio. Drives the env accent
 * colours AND visit merging in periodSummary (activities in the same sitting
 * only merge when the environment matches — a swim followed straight by gym
 * is two sessions, rowing warm-up + lifting is one).
 */
export type ActivityEnvironment = 'water' | 'indoor' | 'outdoor'

export function activityEnvironment(type: string): ActivityEnvironment {
  const t = type.toLowerCase()
  if (/swim|surf|paddle|kayak|dive|water/.test(t)) return 'water'
  if (/indoor|treadmill|elliptical|strength|core|gym|row|weight|lift|pilates|yoga|functional|spin/.test(t)) {
    return 'indoor'
  }
  return 'outdoor'
}
