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
