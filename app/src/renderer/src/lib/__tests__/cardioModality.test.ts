import { describe, expect, it } from 'vitest'
import { cardioModalityOf, cardioModalityByKey, CARDIO_MODALITIES } from '../cardioModality'

describe('cardioModalityOf', () => {
  it('maps pool_swim to swim', () => {
    expect(cardioModalityOf('pool_swim')).toBe('swim')
  })

  it('maps open_water_swim to swim', () => {
    expect(cardioModalityOf('open_water_swim')).toBe('swim')
  })

  it('maps indoor_cycling to cycling', () => {
    expect(cardioModalityOf('indoor_cycling')).toBe('cycling')
  })

  it('maps biking variants to cycling via the biking synonym', () => {
    expect(cardioModalityOf('mountain_biking')).toBe('cycling')
  })

  it('maps rowing to rowing', () => {
    expect(cardioModalityOf('rowing')).toBe('rowing')
  })

  it('maps elliptical to elliptical', () => {
    expect(cardioModalityOf('elliptical')).toBe('elliptical')
  })

  it('maps indoor_walk and outdoor_walk to walking', () => {
    expect(cardioModalityOf('indoor_walk')).toBe('walking')
    expect(cardioModalityOf('outdoor_walk')).toBe('walking')
  })

  it('maps hiking to walking via the hiking synonym', () => {
    expect(cardioModalityOf('hiking')).toBe('walking')
  })

  it('returns null for strength / core / non-cardio types', () => {
    expect(cardioModalityOf('functional_strength_training')).toBeNull()
    expect(cardioModalityOf('core_training')).toBeNull()
    expect(cardioModalityOf('other')).toBeNull()
  })

  it('returns null for null / empty type', () => {
    expect(cardioModalityOf(null)).toBeNull()
    expect(cardioModalityOf(undefined)).toBeNull()
    expect(cardioModalityOf('')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(cardioModalityOf('POOL_SWIM')).toBe('swim')
  })
})

describe('cardioModalityByKey', () => {
  it('resolves every key to a definition with a label', () => {
    for (const m of CARDIO_MODALITIES) {
      expect(cardioModalityByKey(m.key).label).toBe(m.label)
    }
  })
})
