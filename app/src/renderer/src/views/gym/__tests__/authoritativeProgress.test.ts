import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('authoritative create progress', () => {
  it('keeps exercise creation visible while waiting for its database id', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../ExercisePicker.tsx'), 'utf8')
    expect(source).toContain('Creating “{trimmed}”…')
    expect(source).toContain('addExercise.isPending')
  })
})
