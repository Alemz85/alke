import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')

describe('injury date-field editing stability', () => {
  it('defines a shared DateEditField that commits on blur/Enter, not onChange', () => {
    const fieldMatch = source.match(/function DateEditField\([\s\S]*?\n}\n/)
    expect(fieldMatch).not.toBeNull()
    const body = fieldMatch?.[0] ?? ''

    // onChange must only update local draft state — never call the commit
    // callback or close the field. This was the root cause of "clicking a
    // single day / typing a single digit immediately registers the change".
    const onChangeMatch = body.match(/onChange=\{[\s\S]*?\n\s*\}\}/)
    expect(onChangeMatch).not.toBeNull()
    expect(onChangeMatch?.[0]).toContain('setDraft')
    expect(onChangeMatch?.[0]).not.toContain('onCommit')

    // Commit happens on blur and on Enter only.
    expect(body).toContain('onBlur={')
    expect(body).toContain("event.key === 'Enter'")
    expect(body).toContain('commitIfChanged')

    // Escape cancels back to the last committed value without saving.
    expect(body).toContain("event.key === 'Escape'")
  })

  it('PlanStartControl and StartedAtControl both use DateEditField instead of a raw onChange-commits input', () => {
    const planControl = source.match(/function PlanStartControl\([\s\S]*?\n}\n/)?.[0] ?? ''
    const startedControl = source.match(/function StartedAtControl\([\s\S]*?\n}\n/)?.[0] ?? ''

    for (const body of [planControl, startedControl]) {
      expect(body).toContain('<DateEditField')
      expect(body).toContain('onCommit={(nextValue) => mutation.mutate(nextValue)}')
      // Neither control should close its own editing state inside onMutate
      // anymore — closing early is what slammed the field shut on the first
      // keystroke/click before the user had finished composing a value.
      const onMutateMatch = body.match(/onMutate: async[\s\S]*?\n\s*\},/)
      expect(onMutateMatch).not.toBeNull()
      expect(onMutateMatch?.[0]).not.toContain('setEditing(false)')
    }
  })

  it('closes editing only once the mutation actually succeeds', () => {
    const planControl = source.match(/function PlanStartControl\([\s\S]*?\n}\n/)?.[0] ?? ''
    const startedControl = source.match(/function StartedAtControl\([\s\S]*?\n}\n/)?.[0] ?? ''
    for (const body of [planControl, startedControl]) {
      const onSuccessMatch = body.match(/onSuccess: \(result\) => \{[\s\S]*?\n\s*\},/)
      expect(onSuccessMatch).not.toBeNull()
      expect(onSuccessMatch?.[0]).toContain('setEditing(false)')
    }
  })
})
