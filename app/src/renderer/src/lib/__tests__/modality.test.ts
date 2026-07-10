import { describe, expect, it } from 'vitest'
import { workoutMatchesGoal } from '../modality'

describe('workoutMatchesGoal', () => {
  it('matches swim goal against pool_swim', () => {
    expect(workoutMatchesGoal('pool_swim', 'swim')).toBe(true)
  })

  it('matches swim goal against open_water_swim', () => {
    expect(workoutMatchesGoal('open_water_swim', 'swim')).toBe(true)
  })

  it('matches lift goal against functional_strength_training via the strength synonym', () => {
    expect(workoutMatchesGoal('functional_strength_training', 'lift')).toBe(true)
  })

  it('matches lift goal against traditional_strength_training via the strength synonym', () => {
    expect(workoutMatchesGoal('traditional_strength_training', 'lift')).toBe(true)
  })

  it('matches bike goal against indoor_cycling via the cycling synonym', () => {
    expect(workoutMatchesGoal('indoor_cycling', 'bike')).toBe(true)
  })

  it('matches directly via substring when the goal key itself appears in the type', () => {
    expect(workoutMatchesGoal('rowing_machine', 'row')).toBe(true)
  })

  it('returns false for a null workout type', () => {
    expect(workoutMatchesGoal(null, 'swim')).toBe(false)
  })

  it('returns false for an unknown goal key with no synonyms and no substring match', () => {
    expect(workoutMatchesGoal('pool_swim', 'yoga')).toBe(false)
  })

  it('does not match core_training against the lift goal', () => {
    expect(workoutMatchesGoal('core_training', 'lift')).toBe(false)
  })

  it('is case-insensitive on both type and goal', () => {
    expect(workoutMatchesGoal('POOL_SWIM', 'SWIM')).toBe(true)
  })

  it('matches cardio goal against elliptical via synonym', () => {
    expect(workoutMatchesGoal('elliptical', 'cardio')).toBe(true)
  })
})
