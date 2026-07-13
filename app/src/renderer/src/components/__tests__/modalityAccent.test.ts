import { describe, expect, it } from 'vitest'
import { activityGroupLabel, modalityLabel, modalityToDomain } from '../modalityAccent'

describe('modalityToDomain', () => {
  it('treats running as aerobic data', () => {
    expect(modalityToDomain('running')).toBe('aerobic')
    expect(modalityToDomain('run')).toBe('aerobic')
  })
})

describe('modalityLabel', () => {
  it('collapses every strength/core variant to "Gym"', () => {
    expect(modalityLabel('functional_strength_training')).toBe('Gym')
    expect(modalityLabel('traditional_strength_training')).toBe('Gym')
    expect(modalityLabel('core_training')).toBe('Gym')
  })

  it('keeps specific names for non-strength types', () => {
    expect(modalityLabel('pool_swim')).toBe('Pool Swim')
    expect(modalityLabel('indoor_cycling')).toBe('Indoor Cycling')
  })
})

describe('activityGroupLabel', () => {
  it('merges strength into a single "Gym" group', () => {
    expect(activityGroupLabel('functional_strength_training')).toBe('Gym')
    expect(activityGroupLabel('traditional_strength_training')).toBe('Gym')
  })

  it('collapses cardio variants to their modality family (matches the cardio tab labels)', () => {
    expect(activityGroupLabel('pool_swim')).toBe('Swim')
    expect(activityGroupLabel('open_water_swim')).toBe('Swim')
    expect(activityGroupLabel('treadmill_running')).toBe('Running')
    expect(activityGroupLabel('indoor_cycling')).toBe('Cycling')
  })
})
