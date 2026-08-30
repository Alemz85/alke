import { describe, expect, it } from 'vitest'
import { manualFieldsFor, parseField, type FieldSpec } from '../ManualCardioInputs'

/**
 * The per-modality routing here MIRRORS metrics/models.py (ef_distance_m /
 * power_ef / is_rowing_modality). If the two ever disagree, the app offers a
 * field the nightly job will not read — so these cases pin the same modality
 * decisions the Python tests pin.
 */
describe('manualFieldsFor', () => {
  it('offers watts, not distance, for an indoor bike', () => {
    const fields = manualFieldsFor('indoor_cycling')
    expect(fields?.map((f) => f.key)).toEqual(['manual_avg_watts'])
  })

  it('offers distance for a rowing erg', () => {
    expect(manualFieldsFor('rowing')?.map((f) => f.key)).toEqual(['manual_distance_m'])
  })

  it('offers distance AND incline for a treadmill run', () => {
    expect(manualFieldsFor('indoor_run')?.map((f) => f.key)).toEqual([
      'manual_distance_m',
      'manual_incline_pct'
    ])
  })

  it('offers nothing for outdoor sessions, which already carry GPS distance', () => {
    expect(manualFieldsFor('outdoor_run')).toBeNull()
    expect(manualFieldsFor('outdoor_cycling')).toBeNull()
    expect(manualFieldsFor('pool_swim')).toBeNull()
    expect(manualFieldsFor('functional_strength_training')).toBeNull()
  })

  it('matches rowing at a word start, so "throwing" is not a rower', () => {
    expect(manualFieldsFor('throwing_sports')).toBeNull()
    expect(manualFieldsFor('indoor_rowing')?.map((f) => f.key)).toEqual(['manual_distance_m'])
  })
})

describe('parseField', () => {
  const watts: FieldSpec = {
    key: 'manual_avg_watts',
    label: 'Avg power',
    unit: 'W',
    min: 1,
    max: 1999,
    hint: ''
  }
  const incline: FieldSpec = {
    key: 'manual_incline_pct',
    label: 'Incline',
    unit: '%',
    min: -30,
    max: 40,
    hint: ''
  }

  it('reads a number', () => {
    expect(parseField('160', watts)).toBe(160)
    expect(parseField(' 162.5 ', watts)).toBe(162.5)
  })

  it('treats an empty field as CLEARING the value, not as zero', () => {
    expect(parseField('', watts)).toBeNull()
    expect(parseField('   ', watts)).toBeNull()
  })

  it('rejects values the DB check constraints would reject', () => {
    expect(parseField('0', watts)).toBe('invalid')
    expect(parseField('2500', watts)).toBe('invalid')
    expect(parseField('abc', watts)).toBe('invalid')
    expect(parseField('99', incline)).toBe('invalid')
  })

  it('accepts a flat and a negative incline — 0 is a real logged grade', () => {
    expect(parseField('0', incline)).toBe(0)
    expect(parseField('-1.5', incline)).toBe(-1.5)
  })
})
