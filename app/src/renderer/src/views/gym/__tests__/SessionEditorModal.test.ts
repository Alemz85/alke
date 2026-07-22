import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Exercise } from '@shared/types'
import {
  derivedBodyParts,
  blockEccentricState,
  eccentricFlagsForQuickSetRebuild,
  insertBlockAfter,
  moveBlock,
  quickSetFieldValue,
  type Block,
  type SetRow
} from '../SessionEditorModal'
import { buildQuickSetRows, uniformPrefillDose } from '../../../lib/gymLog'

// SessionEditorModal.tsx renders through useExercises/useAddGymSession etc.
// (react-query hooks needing a QueryClientProvider this repo's test setup
// doesn't wire up — see TemplateEditorModal.test.ts's itemsFromTemplate for
// the same reasoning), so the count-sync/derived-chip *logic* is exercised
// here as the plain exported functions/helpers, and the JSX *wiring* that
// glues them to the two inputs/chip row is checked as a source contract
// (ChatView.test.ts's approach) so a refactor that silently drops the
// onFocus/onBlur draft handling or reintroduces stale useState fails loudly.
const source = readFileSync(new URL('../SessionEditorModal.tsx', import.meta.url), 'utf8')

function makeSetRow(overrides: Partial<SetRow> = {}): SetRow {
  return {
    key: 'row-1',
    exerciseId: 'ex-1',
    exerciseName: 'Back Squat',
    reps: 8,
    weightKg: 60,
    rpe: null,
    note: '',
    isWarmup: false,
    isEccentric: false,
    ...overrides
  }
}

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    key: 'block-1',
    exerciseId: 'ex-1',
    exerciseName: 'Back Squat',
    bodyPartFilter: null,
    isEccentric: false,
    rows: [makeSetRow()],
    ...overrides
  }
}

function makeExercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: 'ex-1',
    name: 'Back Squat',
    aliases: [],
    body_part: 'legs',
    primary_muscles: [],
    secondary_muscles: [],
    equipment: null,
    mechanics: null,
    movement_pattern: null,
    source: 'catalog',
    created_at: null,
    ...overrides
  }
}

describe('quickSetFieldValue (Sets/Reps box two-way sync)', () => {
  it('shows the derived value when the field is not being edited (draft is null)', () => {
    expect(quickSetFieldValue(null, '3')).toBe('3')
  })

  it('shows the in-progress keystrokes while focused, ignoring the derived value', () => {
    // Mid-keystroke typing "12": draft is "1" while derived may already have
    // jumped elsewhere — the draft must win so the digit isn't clobbered.
    expect(quickSetFieldValue('1', '4')).toBe('1')
  })

  it('falls back to derived the instant the draft clears (field blurred)', () => {
    expect(quickSetFieldValue(null, '5')).toBe('5')
  })
})

describe('exercise block ordering', () => {
  const first = makeBlock({ key: 'first', rows: [makeSetRow({ key: 'first-row' })] })
  const second = makeBlock({ key: 'second', rows: [makeSetRow({ key: 'second-row' })] })
  const third = makeBlock({ key: 'third', rows: [makeSetRow({ key: 'third-row' })] })

  it('moves a whole block without mutating the source or splitting its sets', () => {
    const blocks = [first, second, third]
    const moved = moveBlock(blocks, 'second', 'up')

    expect(moved.map((block) => block.key)).toEqual(['second', 'first', 'third'])
    expect(moved[0].rows).toEqual([makeSetRow({ key: 'second-row' })])
    expect(blocks.map((block) => block.key)).toEqual(['first', 'second', 'third'])
  })

  it('keeps a boundary block in place', () => {
    expect(moveBlock([first, second], 'first', 'up')).toEqual([first, second])
    expect(moveBlock([first, second], 'second', 'down')).toEqual([first, second])
  })

  it('inserts a complete new block after the requested exercise and retains append fallback', () => {
    const inserted = makeBlock({ key: 'inserted', rows: [makeSetRow({ key: 'inserted-row' })] })
    expect(insertBlockAfter([first, second], 'first', inserted).map((block) => block.key)).toEqual([
      'first',
      'inserted',
      'second'
    ])
    expect(insertBlockAfter([first], 'missing', inserted).map((block) => block.key)).toEqual([
      'first',
      'inserted'
    ])
  })
})

describe('eccentric block flag (source contract)', () => {
  it('hydrates at block level and serializes only working sets', () => {
    expect(source).toContain('isEccentric: s.is_eccentric')
    expect(source).toContain('is_eccentric: row.isEccentric && !row.isWarmup')
  })

  it('presents a neutral block-level checkbox', () => {
    expect(source).toContain('checked={eccentricState === true}')
    expect(source).toContain('Eccentric')
  })
})

describe('eccentric set preservation (source contract)', () => {
  it('reports a mixed working-set block without counting warm-ups', () => {
    expect(
      blockEccentricState([
        makeSetRow({ isEccentric: true }),
        makeSetRow({ key: 'r2', isEccentric: false }),
        makeSetRow({ key: 'r3', isWarmup: true, isEccentric: true })
      ])
    ).toBe('mixed')
  })

  it('round-trips the per-set value so a mixed block survives unrelated edits', () => {
    expect(source).toContain('isEccentric: s.is_eccentric')
    expect(source).toContain('is_eccentric: row.isEccentric && !row.isWarmup')
  })

  it('derives the block control from working rows and toggles those rows together', () => {
    expect(source).toContain('const eccentricState = blockEccentricState(block.rows)')
    expect(source).toMatch(
      /rows: block\.rows\.map\(\(row\) => \(\{[\s\S]*isEccentric: !row\.isWarmup && event\.target\.checked/
    )
    expect(source).toContain(
      "eccentricCheckboxRef.current.indeterminate = eccentricState === 'mixed'"
    )
  })

  it('keeps a new copied set aligned to the existing row flag', () => {
    expect(source).toContain("? { ...last, key: nextKey(), rpe: null, note: '' }")
  })

  it('keeps mixed flags by index when quick Sets/Reps rebuilds rows', () => {
    const existing = [
      makeSetRow({ key: 'r1', isEccentric: true }),
      makeSetRow({ key: 'r2', isEccentric: false })
    ]
    expect(eccentricFlagsForQuickSetRebuild(existing, 4)).toEqual([true, false, false, false])
    expect(eccentricFlagsForQuickSetRebuild(existing, 1)).toEqual([true])
  })

  it('indexes existing working sets without letting warm-ups shift eccentric flags', () => {
    const existing = [
      makeSetRow({ key: 'warmup', isWarmup: true, isEccentric: false }),
      makeSetRow({ key: 'work-1', isEccentric: true }),
      makeSetRow({ key: 'work-2', isEccentric: false })
    ]

    expect(eccentricFlagsForQuickSetRebuild(existing, 3)).toEqual([true, false, false])
  })
})

describe('dirty draft safety (source contract)', () => {
  it('uses a versioned target-specific local draft and preserves save-relevant fields without UI keys', () => {
    expect(source).toContain("const DRAFT_VERSION = 'v1'")
    expect(source).toContain('function draftStorageKey(target: EditorTarget): string')
    expect(source).toMatch(/target\.kind === 'edit'\s*\? `edit:\$\{target\.session\.id\}`/)
    expect(source).toMatch(/target\.kind === 'new-linked'\s*\? `workout:\$\{target\.workout\.id\}`/)
    expect(source).toContain('function serializeDraft(')
    expect(source).toContain('baseUpdatedAt')
    expect(source).toContain('exerciseId: block.exerciseId')
    expect(source).toContain('localStorage.setItem(draftKey, JSON.stringify(currentDraft))')
    expect(source).toContain('flushDraftOnUnmount')
    expect(source).toContain('const isDirty = restoredDraft !== null ||')
  })

  it('freezes the edit revision accepted at mount so a refetch cannot relabel a stale draft', () => {
    expect(source).toContain(
      'const [baseUpdatedAt] = useState<string | null>(() => existingSession?.updated_at ?? null)'
    )
    expect(source).toContain('serializeDraft(baseUpdatedAt, {')
    expect(source).not.toContain('serializeDraft(existingSession?.updated_at ?? null, {')
  })

  it('guards every close path and waits for mutateAsync success before closing', () => {
    expect(source).toContain('const requestClose = (): void =>')
    expect(source).toContain('setShowDiscardGuard(true)')
    expect(source).toContain("window.addEventListener('beforeunload', onBeforeUnload)")
    expect(source).toContain('await updateMutation.mutateAsync(')
    expect(source).toContain('await addMutation.mutateAsync(payload)')
    expect(source).toContain('Discard draft')
    expect(source).toContain('Keep editing')
    expect(source).toContain('Draft saved locally')
  })

  it('uses a native dialog that focuses save and treats Escape as keep editing', () => {
    expect(source).toContain('<dialog')
    expect(source).toContain('showModal()')
    expect(source).toContain('primaryGuardActionRef.current?.focus()')
    expect(source).toContain('onCancel={(event) =>')
    expect(source).toContain('event.preventDefault()')
  })

  it('closes the top-layer guard before saving so validation and mutation errors stay visible', () => {
    expect(source).toContain('const saveFromDiscardGuard = (): void =>')
    expect(source).toMatch(
      /const saveFromDiscardGuard = \(\): void => \{\s*setShowDiscardGuard\(false\)\s*void handleSave\(\)/
    )
    expect(source).toContain('onClick={saveFromDiscardGuard}')
  })

  it('moves focus into the modal and announces save or validation errors', () => {
    expect(source).toContain('modalInitialFocusRef.current?.focus()')
    expect(source).toContain('ref={modalInitialFocusRef}')
    expect(source).toContain('<p className="gym-error" role="alert">')
  })
})

describe('Sets count reflects manual row adds/removes (uniformPrefillDose as the derivation)', () => {
  it('a manual +set (append a row copy) increments what the Sets box would show', () => {
    const block = makeBlock({ rows: [makeSetRow({ key: 'r1' }), makeSetRow({ key: 'r2' })] })
    const before = uniformPrefillDose(block.rows)
    expect(before.sets).toBe('2')

    // addSet's own logic: copy the last row with a fresh key.
    const afterAdd = { ...block, rows: [...block.rows, { ...block.rows[1], key: 'r3' }] }
    const after = uniformPrefillDose(afterAdd.rows)
    expect(after.sets).toBe('3')
  })

  it('removing a row via × decrements what the Sets box would show', () => {
    const block = makeBlock({
      rows: [makeSetRow({ key: 'r1' }), makeSetRow({ key: 'r2' }), makeSetRow({ key: 'r3' })]
    })
    const afterRemove = { ...block, rows: block.rows.filter((r) => r.key !== 'r2') }
    expect(uniformPrefillDose(afterRemove.rows).sets).toBe('2')
  })

  it('typing a Sets count still bulk-generates that many rows via buildQuickSetRows', () => {
    const rows = buildQuickSetRows('ex-1', 'Back Squat', 4, 10)
    expect(rows).toHaveLength(4)
    expect(rows?.every((r) => r.reps === 10 && r.exerciseId === 'ex-1')).toBe(true)
    expect(uniformPrefillDose(rows ?? []).sets).toBe('4')
  })

  it('reps go blank (not a stale number) once a manual edit makes them non-uniform', () => {
    const block = makeBlock({
      rows: [makeSetRow({ key: 'r1', reps: 8 }), makeSetRow({ key: 'r2', reps: 6 })]
    })
    expect(uniformPrefillDose(block.rows).reps).toBe('')
  })
})

describe('derivedBodyParts (body-part chips, derived-from-sets tier)', () => {
  it('resolves the body part for each block from the exercise catalog', () => {
    const blocks = [makeBlock({ exerciseId: 'ex-1' })]
    const exercisesById = new Map([['ex-1', makeExercise({ body_part: 'legs' })]])
    expect(derivedBodyParts(blocks, exercisesById)).toEqual(['legs'])
  })

  it('dedupes and orders results in the canon GYM_BODY_PARTS order, not append order', () => {
    const blocks = [
      makeBlock({ key: 'b1', exerciseId: 'ex-legs' }),
      makeBlock({ key: 'b2', exerciseId: 'ex-chest' }),
      makeBlock({ key: 'b3', exerciseId: 'ex-legs-2' }) // same body part, different exercise
    ]
    const exercisesById = new Map<string, Exercise>([
      ['ex-legs', makeExercise({ id: 'ex-legs', body_part: 'legs' })],
      ['ex-chest', makeExercise({ id: 'ex-chest', name: 'Bench', body_part: 'chest' })],
      ['ex-legs-2', makeExercise({ id: 'ex-legs-2', name: 'Lunge', body_part: 'legs' })]
    ])
    // chest precedes legs in GYM_BODY_PARTS, despite legs being added first.
    expect(derivedBodyParts(blocks, exercisesById)).toEqual(['chest', 'legs'])
  })

  it('ignores blocks with no resolved exercise yet', () => {
    const blocks = [makeBlock({ exerciseId: null, exerciseName: '' })]
    expect(derivedBodyParts(blocks, new Map())).toEqual([])
  })

  it('ignores exercises with no catalog body_part on record', () => {
    const blocks = [makeBlock({ exerciseId: 'ex-1' })]
    const exercisesById = new Map([['ex-1', makeExercise({ body_part: null })]])
    expect(derivedBodyParts(blocks, exercisesById)).toEqual([])
  })

  it('returns empty for an empty session (no blocks)', () => {
    expect(derivedBodyParts([], new Map())).toEqual([])
  })
})

describe('Sets/Reps input wiring (source contract)', () => {
  it('derives the displayed value from block.rows via uniformPrefillDose, not a value seeded once at mount', () => {
    expect(source).toContain('const derivedDose = uniformPrefillDose(block.rows)')
    expect(source).toContain('const quickSets = quickSetFieldValue(setsDraft, derivedDose.sets)')
    expect(source).toContain('const quickReps = quickSetFieldValue(repsDraft, derivedDose.reps)')
    // Guards against regressing to the old bug: quickSets/quickReps must not
    // be their own useState seeded from a one-time initialDose snapshot.
    expect(source).not.toMatch(/const \[quickSets, setQuickSets\] = useState/)
    expect(source).not.toMatch(/const \[quickReps, setQuickReps\] = useState/)
  })

  it('the Sets input clears its draft on blur so it snaps back to the derived count', () => {
    const setsFieldMatch = source.match(/placeholder="3"[\s\S]*?\/>/)
    expect(setsFieldMatch).not.toBeNull()
    const setsField = setsFieldMatch?.[0] ?? ''
    expect(setsField).toContain('onFocus={() => setSetsDraft(quickSets)}')
    expect(setsField).toContain('setSetsDraft(value)')
    expect(setsField).toContain('onBlur={() => setSetsDraft(null)}')
  })

  it('the Reps input clears its draft on blur so it snaps back to the derived value', () => {
    const repsFieldMatch = source.match(/placeholder="8"[\s\S]*?\/>/)
    expect(repsFieldMatch).not.toBeNull()
    const repsField = repsFieldMatch?.[0] ?? ''
    expect(repsField).toContain('onFocus={() => setRepsDraft(quickReps)}')
    expect(repsField).toContain('setRepsDraft(value)')
    expect(repsField).toContain('onBlur={() => setRepsDraft(null)}')
  })
})

describe('Derived body-part chips presentation (source contract)', () => {
  it('renders derived chips as passive spans, not toggle buttons', () => {
    const chipsBlockMatch = source.match(
      /<div className="gym-bodypart-chips">([\s\S]*?)\n {12}<\/div>/
    )
    expect(chipsBlockMatch).not.toBeNull()
    const chipsBlock = chipsBlockMatch?.[1] ?? ''
    expect(chipsBlock).toContain('derivedParts.map((part) => (')
    expect(chipsBlock).toContain('<span')
    expect(chipsBlock).toContain('aria-disabled="true"')
  })

  it('keeps the freely-toggleable button chips untouched when there are no sets yet', () => {
    const chipsBlockMatch = source.match(
      /<div className="gym-bodypart-chips">([\s\S]*?)\n {12}<\/div>/
    )
    const chipsBlock = chipsBlockMatch?.[1] ?? ''
    expect(chipsBlock).toContain('GYM_BODY_PARTS.map((part) => {')
    expect(chipsBlock).toContain('<button')
    expect(chipsBlock).toContain('onClick={() => toggleBodyPart(part)}')
    // The old disabled={chipsDerived} button attribute is gone now that the
    // derived tier renders as spans instead of disabled buttons.
    expect(source).not.toMatch(/disabled=\{chipsDerived\}/)
  })

  it('shows the "derived from sets" caption only in the derived tier', () => {
    expect(source).toContain(
      '{chipsDerived && <span className="gym-field-label-note"> · derived from sets</span>}'
    )
  })
})

describe('Set effort and note wiring (source contract)', () => {
  it('hydrates and saves RPE and note with the rest of each set row', () => {
    expect(source).toContain('rpe: s.rpe')
    expect(source).toContain('note: s.note')
    expect(source).toContain('rpe: row.rpe')
    expect(source).toContain('note: row.note.trim() || null')
  })

  it('offers constrained optional controls without turning them into required data', () => {
    expect(source).toContain('aria-label={`Set ${index + 1} RPE`}')
    expect(source).toContain('min="1"')
    expect(source).toContain('max="10"')
    expect(source).toContain('step="0.5"')
    expect(source).toContain('aria-label={`Set ${index + 1} note`}')
    expect(source).toContain('maxLength={500}')
  })
})
