import { describe, expect, it } from 'vitest'
import { activityGroupLabel, modalityLabel, modalityToDomain } from '../modalityAccent'

describe('modalityToDomain', () => {
  it('treats running as aerobic data', () => {
    expect(modalityToDomain('running')).toBe('aerobic')
    expect(modalityToDomain('run')).toBe('aerobic')
  })

  it('treats real strength ingest types as load, not neutral (confirmed real HAE types)', () => {
    // Bug: these compound strings never matched the old exact-match table,
    // so they silently fell through to 'neutral' even though modalityLabel
    // (same file) and ModalityIcon both already classify them as Gym/strength.
    expect(modalityToDomain('functional_strength_training')).toBe('load')
    expect(modalityToDomain('traditional_strength_training')).toBe('load')
    expect(modalityToDomain('core_training')).toBe('load')
  })

  it('treats other real cardio ingest variants as aerobic, not just the short tokens', () => {
    expect(modalityToDomain('pool_swim')).toBe('aerobic')
    expect(modalityToDomain('open_water_swim')).toBe('aerobic')
    expect(modalityToDomain('indoor_cycling')).toBe('aerobic')
    expect(modalityToDomain('treadmill_running')).toBe('aerobic')
  })

  it('keeps walking neutral (not aerobic) and surf as sessions, per the exact-match table', () => {
    expect(modalityToDomain('walking')).toBe('neutral')
    expect(modalityToDomain('walk')).toBe('neutral')
    expect(modalityToDomain('surf')).toBe('sessions')
    expect(modalityToDomain('surfing')).toBe('sessions')
  })

  it('defaults a truly unknown type to neutral', () => {
    expect(modalityToDomain('teleportation')).toBe('neutral')
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
