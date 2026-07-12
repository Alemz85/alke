import { describe, expect, it } from 'vitest'
import type { Exercise } from '@shared/types'
import { rankExercises, type ExerciseUsageEntry } from '../exerciseSearch'

function exercise(partial: Partial<Exercise> & { id: string; name: string }): Exercise {
  return {
    aliases: [],
    body_part: null,
    primary_muscles: [],
    secondary_muscles: [],
    equipment: null,
    mechanics: null,
    movement_pattern: null,
    source: 'catalog',
    created_at: null,
    ...partial
  }
}

const CATALOG: Exercise[] = [
  exercise({
    id: 'rdl',
    name: 'Romanian Deadlift',
    aliases: ['rdl', 'stacco rumeno'],
    body_part: 'legs'
  }),
  exercise({
    id: 'deadlift',
    name: 'Deadlift',
    aliases: ['stacco da terra', 'conventional deadlift'],
    body_part: 'back'
  }),
  exercise({
    id: 'latpulldown',
    name: 'Lat Pulldown',
    aliases: ['lat machine', 'pulldown'],
    body_part: 'back'
  }),
  exercise({ id: 'squat', name: 'Back Squat', aliases: ['barbell squat'], body_part: 'legs' }),
  exercise({ id: 'legpress', name: 'Leg Press', aliases: ['pressa'], body_part: 'legs' }),
  exercise({ id: 'legext', name: 'Leg Extension', aliases: [], body_part: 'legs' }),
  exercise({ id: 'legcurl', name: 'Lying Leg Curl', aliases: [], body_part: 'legs' }),
  exercise({ id: 'lunge', name: 'Walking Lunge', aliases: ['affondi'], body_part: 'legs' }),
  exercise({ id: 'custom', name: 'My Custom Thing', aliases: [], body_part: null, source: 'user' })
]

describe('rankExercises', () => {
  it('matches Italian aliases mid-typing', () => {
    const results = rankExercises('stacco rum', CATALOG)
    expect(results[0]?.id).toBe('rdl')
  })

  it('matches abbreviations exactly', () => {
    expect(rankExercises('rdl', CATALOG)[0]?.id).toBe('rdl')
  })

  it('strips diacritics from the query', () => {
    expect(rankExercises('préssa', CATALOG)[0]?.id).toBe('legpress')
  })

  it('ranks a name match above an alias match in the same tier', () => {
    // "deadlift" is Deadlift's name (exact) and only part of RDL's name
    const results = rankExercises('deadlift', CATALOG)
    expect(results[0]?.id).toBe('deadlift')
  })

  it('usage boost reorders within a tier', () => {
    const usage = new Map<string, ExerciseUsageEntry>([
      ['legext', { count: 5, lastIso: null }]
    ])
    const without = rankExercises('leg', CATALOG)
    const withUsage = rankExercises('leg', CATALOG, { usage })
    expect(without[0]?.id).toBe('legext') // alphabetical within tier: Extension < Press
    expect(withUsage[0]?.id).toBe('legext')
    // boost a different one and it wins instead
    const usage2 = new Map<string, ExerciseUsageEntry>([
      ['legpress', { count: 5, lastIso: null }]
    ])
    expect(rankExercises('leg', CATALOG, { usage: usage2 })[0]?.id).toBe('legpress')
  })

  it('hard-filters by body part', () => {
    const results = rankExercises('stacco', CATALOG, { bodyPart: 'legs' })
    expect(results.map((r) => r.id)).toEqual(['rdl'])
  })

  it('empty query with a body-part filter returns the top 5 for that part', () => {
    const usage = new Map<string, ExerciseUsageEntry>([
      ['lunge', { count: 3, lastIso: null }]
    ])
    const results = rankExercises('', CATALOG, { bodyPart: 'legs', usage })
    expect(results).toHaveLength(5)
    expect(results[0]?.id).toBe('lunge') // usage first, then alphabetical
    expect(results.every((r) => r.body_part === 'legs')).toBe(true)
  })

  it('empty query without a filter returns nothing', () => {
    expect(rankExercises('  ', CATALOG)).toEqual([])
  })

  it('caps results at 5', () => {
    expect(rankExercises('l', CATALOG).length).toBeLessThanOrEqual(5)
  })

  it('customs with null body_part are excluded by a body-part filter but findable without one', () => {
    expect(rankExercises('custom', CATALOG, { bodyPart: 'legs' })).toEqual([])
    expect(rankExercises('custom', CATALOG)[0]?.id).toBe('custom')
  })
})
