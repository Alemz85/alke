// The Gym tab's core interaction: log or edit a session. Handles both "quick
// log" (title/template/notes only, zero set rows) and "full log" (exercise
// blocks with per-set reps/kg/effort/notes) — dual granularity is a data shape, not
// a UI mode, so both are the same form with the set editor optionally empty.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  GYM_BODY_PARTS,
  type Exercise,
  type GymBodyPart,
  type GymSession,
  type GymTemplate,
  type NewGymSession,
  type Workout
} from '@shared/types'
import {
  useAddGymSession,
  useDeleteGymSession,
  useExercises,
  useUpdateGymSession
} from '../../hooks/useGymData'
import {
  displayBodyPart,
  buildQuickSetRows,
  exerciseUsage,
  formatSetLine,
  groupSetsIntoBlocks,
  lastPerformance,
  prefillFromTemplates,
  uniformPrefillDose,
  type PrefillSetRow
} from '../../lib/gymLog'
import { formatDurationHM } from '../../lib/format'
import {
  formatLocalTime,
  formatZonedDateTimeLocal,
  todayYMD,
  ymdKey,
  zonedDateTimeLocalToIso
} from '../../hooks/sessionsDate'
import { currentPlanWeek, resolveItemTargets } from '../../lib/injuryStats'
import type { RecoveryLogTemplate } from '../../lib/recoveryLogTemplates'
import { Dropdown } from '../../components/Dropdown'
import { RecoveryRoutineTable } from '../../components/RecoveryPlanDetail'
import { ExercisePicker } from './ExercisePicker'
import type { DoseUnit } from './TemplateEditorModal'
import '../GymView.css'

const BODY_PART_OPTIONS = [
  { value: '', label: 'Any body part' },
  ...GYM_BODY_PARTS.map((part) => ({ value: part, label: displayBodyPart(part) }))
]

/** "Jul 7" — matches GymView's row date style. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export type EditorTarget =
  | { kind: 'new-linked'; workout: Workout; recoveryTemplateId?: string }
  | { kind: 'new-unlinked'; recoveryTemplateId?: string }
  | { kind: 'edit'; session: GymSession }

export interface SetRow extends PrefillSetRow {
  key: string
  rpe: number | null
  note: string
  isEccentric: boolean
  // Single-arm/single-leg (e.g. a single-arm cable row) — its weight must
  // never be compared against bilateral sets of the same exercise.
  isUnilateral: boolean
  /** Which dose the row is counting. Editor-local: the payload carries whichever
   *  of reps / durationS this selects, and null for the other. */
  doseUnit: DoseUnit
}

export interface Block {
  key: string
  exerciseId: string | null
  exerciseName: string
  // UI-only picker filter ("body part first, then the suggestions narrow");
  // autofilled in reverse when a picked exercise carries a body_part.
  bodyPartFilter: GymBodyPart | null
  isEccentric: boolean
  isUnilateral: boolean
  rows: SetRow[]
}

export function moveBlock(blocks: Block[], key: string, direction: 'up' | 'down'): Block[] {
  const index = blocks.findIndex((block) => block.key === key)
  const nextIndex = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || nextIndex < 0 || nextIndex >= blocks.length) return blocks
  const next = [...blocks]
  ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
  return next
}

export function insertBlockAfter(blocks: Block[], afterKey: string, block: Block): Block[] {
  const index = blocks.findIndex((candidate) => candidate.key === afterKey)
  return index < 0
    ? [...blocks, block]
    : [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)]
}

/** A block-level flag ("Eccentric"/"Unilateral") is tri-state: off when no
 *  working set carries it, on when every working set does, and 'mixed' when
 *  it varies — warm-ups never count toward or against the state. */
function blockFlagState(rows: SetRow[], key: 'isEccentric' | 'isUnilateral'): boolean | 'mixed' {
  const workingRows = rows.filter((row) => !row.isWarmup)
  if (workingRows.length === 0) return false
  const flaggedCount = workingRows.filter((row) => row[key]).length
  if (flaggedCount === 0) return false
  return flaggedCount === workingRows.length ? true : 'mixed'
}

export function blockEccentricState(rows: SetRow[]): boolean | 'mixed' {
  return blockFlagState(rows, 'isEccentric')
}

export function blockUnilateralState(rows: SetRow[]): boolean | 'mixed' {
  return blockFlagState(rows, 'isUnilateral')
}

/** Preserve an existing per-row flag when the quick Sets/Reps control rebuilds rows. */
function flagsForQuickSetRebuild(
  existingRows: SetRow[],
  nextCount: number,
  key: 'isEccentric' | 'isUnilateral'
): boolean[] {
  const workingRows = existingRows.filter((row) => !row.isWarmup)
  const inherited = workingRows.at(-1)?.[key] ?? blockFlagState(existingRows, key) === true
  return Array.from({ length: nextCount }, (_, index) => workingRows[index]?.[key] ?? inherited)
}

/** Preserve existing eccentric work when the quick Sets/Reps control rebuilds rows. */
export function eccentricFlagsForQuickSetRebuild(
  existingRows: SetRow[],
  nextCount: number
): boolean[] {
  return flagsForQuickSetRebuild(existingRows, nextCount, 'isEccentric')
}

/** Preserve existing unilateral work when the quick Sets/Reps control rebuilds rows. */
export function unilateralFlagsForQuickSetRebuild(
  existingRows: SetRow[],
  nextCount: number
): boolean[] {
  return flagsForQuickSetRebuild(existingRows, nextCount, 'isUnilateral')
}

const DRAFT_VERSION = 'v1'

interface SessionDraft {
  version: typeof DRAFT_VERSION
  baseUpdatedAt: string | null
  title: string
  templateIds: string[]
  recoveryTemplateIds: string[]
  notes: string
  bodyParts: GymBodyPart[]
  performedAt: string
  blocks: {
    exerciseId: string | null
    exerciseName: string
    rows: Omit<SetRow, 'key'>[]
  }[]
}

function draftStorageKey(target: EditorTarget): string {
  const targetKey =
    target.kind === 'edit'
      ? `edit:${target.session.id}`
      : target.kind === 'new-linked'
        ? `workout:${target.workout.id}`
        : 'unlinked'
  return `gym-session-editor-draft:${DRAFT_VERSION}:${targetKey}`
}

function serializeDraft(
  baseUpdatedAt: string | null,
  values: Omit<SessionDraft, 'version' | 'baseUpdatedAt' | 'blocks'> & { blocks: Block[] }
): SessionDraft {
  return {
    version: DRAFT_VERSION,
    baseUpdatedAt,
    ...values,
    blocks: values.blocks.map((block) => ({
      exerciseId: block.exerciseId,
      exerciseName: block.exerciseName,
      rows: block.rows.map(({ key: _rowKey, ...row }) => row)
    }))
  }
}

function readDraft(target: EditorTarget): SessionDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(target))
    if (!raw) return null
    const draft = JSON.parse(raw) as SessionDraft
    if (draft.version !== DRAFT_VERSION) return null
    if (target.kind === 'edit' && draft.baseUpdatedAt !== target.session.updated_at) {
      localStorage.removeItem(draftStorageKey(target))
      return null
    }
    return draft
  } catch {
    return null
  }
}

function blocksFromDraft(blocks: SessionDraft['blocks']): Block[] {
  return blocks.map((block) => {
    const rows = block.rows.map((row) => ({ ...row, key: nextKey() }))
    return {
      key: nextKey(),
      exerciseId: block.exerciseId,
      exerciseName: block.exerciseName,
      bodyPartFilter: null,
      isEccentric: blockEccentricState(rows) === true,
      isUnilateral: blockUnilateralState(rows) === true,
      rows
    }
  })
}

let rowKeySeq = 0
function nextKey(): string {
  rowKeySeq += 1
  return `row-${rowKeySeq}`
}

function blankRow(exerciseId: string, exerciseName: string): SetRow {
  return {
    key: nextKey(),
    exerciseId,
    exerciseName,
    reps: null,
    durationS: null,
    doseUnit: 'reps',
    weightKg: null,
    rpe: null,
    note: '',
    isWarmup: false,
    isEccentric: false,
    isUnilateral: false
  }
}

function blocksFromSession(session: GymSession): Block[] {
  return groupSetsIntoBlocks(session.sets).map((b) => ({
    key: nextKey(),
    exerciseId: b.exerciseId,
    exerciseName: b.exerciseName,
    bodyPartFilter: null,
    isEccentric: b.sets.filter((s) => !s.is_warmup).every((s) => s.is_eccentric),
    isUnilateral: b.sets.filter((s) => !s.is_warmup).every((s) => s.is_unilateral),
    rows: b.sets.map((s) => ({
      key: nextKey(),
      exerciseId: s.exercise_id,
      exerciseName: s.exercise_name,
      // A saved hold reopens as a hold — re-editing must not quietly convert
      // 45 seconds into 45 reps.
      reps: s.reps,
      durationS: s.duration_s,
      doseUnit: s.duration_s != null ? 'secs' : 'reps',
      weightKg: s.weight_kg,
      rpe: s.rpe,
      note: s.note ?? '',
      isWarmup: s.is_warmup,
      isEccentric: s.is_eccentric,
      isUnilateral: s.is_unilateral
    }))
  }))
}

function blocksFromPrefill(rows: PrefillSetRow[]): Block[] {
  const blocks: Block[] = []
  for (const row of rows) {
    const last = blocks[blocks.length - 1]
    if (last && last.exerciseId === row.exerciseId) {
      last.rows.push({
        ...row,
        key: nextKey(),
        doseUnit: row.durationS != null ? 'secs' : 'reps',
        rpe: row.rpe ?? null,
        note: row.note ?? '',
        isEccentric: false,
        isUnilateral: false
      })
    } else {
      blocks.push({
        key: nextKey(),
        exerciseId: row.exerciseId,
        exerciseName: row.exerciseName,
        bodyPartFilter: null,
        isEccentric: false,
        isUnilateral: false,
        rows: [
          {
            ...row,
            key: nextKey(),
            doseUnit: row.durationS != null ? 'secs' : 'reps',
            rpe: row.rpe ?? null,
            note: row.note ?? '',
            isEccentric: false,
            isUnilateral: false
          }
        ]
      })
    }
  }
  return blocks
}

function blocksToNewSets(blocks: Block[]): NewGymSession['sets'] {
  const out: NewGymSession['sets'] = []
  for (const block of blocks) {
    if (!block.exerciseId) continue
    for (const row of block.rows) {
      out.push({
        exercise_id: block.exerciseId,
        // Exactly one dose measure reaches the DB — the unit switch decides
        // which, so the pair can never both be set.
        reps: row.doseUnit === 'reps' ? row.reps : null,
        duration_s: row.doseUnit === 'secs' ? row.durationS ?? null : null,
        weight_kg: row.weightKg,
        rpe: row.rpe,
        note: row.note.trim() || null,
        is_warmup: row.isWarmup,
        is_eccentric: row.isEccentric && !row.isWarmup,
        is_unilateral: row.isUnilateral && !row.isWarmup
      })
    }
  }
  return out
}

/**
 * Pre-flight check of the set rows against the same bounds the main process
 * enforces (db.ts assertGymSets), returning a message that names the offending
 * set — or null when all rows are in range. The main-process assert protects
 * the DB; without this copy a single bad value (found live: a stray "-5" in a
 * reps field) fails the whole save with a generic error, and the restored
 * draft re-fails identically on every retry with no hint of where.
 */
export function firstInvalidSetMessage(blocks: Block[]): string | null {
  for (const block of blocks) {
    if (!block.exerciseId) continue
    for (const [i, row] of block.rows.entries()) {
      const where = `${block.exerciseName || 'Exercise'}, set ${i + 1}`
      if (
        row.doseUnit === 'reps' &&
        row.reps != null &&
        (!Number.isInteger(row.reps) || row.reps < 0 || row.reps > 500)
      ) {
        return `${where}: reps must be a whole number between 0 and 500.`
      }
      if (
        row.doseUnit === 'secs' &&
        row.durationS != null &&
        (!Number.isInteger(row.durationS) || row.durationS < 1 || row.durationS > 3600)
      ) {
        return `${where}: a hold must be between 1 and 3600 seconds.`
      }
      if (row.weightKg != null && (row.weightKg < 0 || row.weightKg > 1500)) {
        return `${where}: weight must be between 0 and 1500 kg.`
      }
      if (row.rpe != null && (row.rpe < 1 || row.rpe > 10)) {
        return `${where}: RPE must be between 1 and 10.`
      }
    }
  }
  return null
}

/**
 * The reason a save was rejected, mined out of the IPC error wrapper
 * ("Error invoking remote method 'x': Error: <detail>"). Null when there is
 * no usable detail (empty or unreasonably long) — the caller falls back to
 * its generic message alone.
 */
export function saveErrorDetail(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const detail = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim()
  return detail.length > 0 && detail.length <= 200 ? detail : null
}

/**
 * The Sets/Reps quick-generator boxes have no state of their own: what they
 * display is either (a) the field's own in-progress keystrokes, while it's
 * focused, or (b) otherwise the true value derived from the row count/reps
 * — so a manual +set/×-remove (which mutate rows, not these fields) is
 * reflected immediately, and typing "1" on the way to "12" never gets
 * clobbered by the derivation racing ahead of the keystroke.
 */
export function quickSetFieldValue(draft: string | null, derived: string): string {
  return draft ?? derived
}

/**
 * Whether a Sets/Reps box's in-progress draft can be safely released back to
 * derived-tracking on blur. Only true once the draft is already reflected in
 * the derived value (i.e. it was successfully committed to rows) — or when
 * there's no draft to release in the first place.
 *
 * This matters because building rows needs BOTH boxes valid at once
 * (buildQuickSetRows), but a user normally fills them one at a time: type
 * Sets, tab to Reps, type Reps. Typing "3" alone can't commit (Reps is still
 * blank), so right after that keystroke the derived value is still blank too.
 * If blur released the draft unconditionally, the "3" the user just typed
 * would vanish the moment they tab away — and since Reps then reads Sets back
 * as blank, the pair never builds any rows: the whole "3 x 12" entry silently
 * gets rejected. Keeping the un-synced draft alive across the tab lets the
 * *next* field's onChange read it back correctly and complete the pair.
 */
export function shouldReleaseQuickSetDraftOnBlur(draft: string | null, derived: string): boolean {
  return draft === null || draft === derived
}

/** Body parts to show as derived tags: only those actually present across
 *  the blocks' resolved exercises, in the canon GYM_BODY_PARTS order. */
export function derivedBodyParts(
  blocks: Block[],
  exercisesById: Map<string, Exercise>
): GymBodyPart[] {
  const found = new Set<string>()
  for (const block of blocks) {
    if (!block.exerciseId) continue
    const part = exercisesById.get(block.exerciseId)?.body_part
    if (part) found.add(part)
  }
  return GYM_BODY_PARTS.filter((p) => found.has(p))
}

// Equipment that is held/loaded one implement per hand — the logging
// convention is ONE implement's weight, never the pair's combined total.
const PER_HAND_EQUIPMENT = new Set(['dumbbell', 'kettlebell'])
// Every other loaded implement in the exercises.equipment vocabulary (see the
// gym_exercise_catalog migration's check constraint): the whole moved load is
// entered as a single total.
const TOTAL_LOAD_EQUIPMENT = new Set([
  'barbell',
  'machine',
  'cable',
  'smith machine',
  'ez bar',
  'trap bar',
  'other'
])

/**
 * The weight-input placeholder teaches the logging convention for the
 * exercise's equipment. 'bodyweight'/'band'/unrecognized/null equipment keep
 * the plain "kg" placeholder — a blank there is a reading (no external load,
 * or nobody recorded one) rather than an omission the input should nudge
 * (agent_log #17), so only equipment we can confidently qualify gets a hint.
 */
export function weightPlaceholderFor(equipment: string | null | undefined): string {
  // Kept short enough to survive the narrow weight input un-clipped.
  if (equipment && PER_HAND_EQUIPMENT.has(equipment)) return 'kg/hand'
  if (equipment && TOTAL_LOAD_EQUIPMENT.has(equipment)) return 'kg total'
  return 'kg'
}

// ── set row ──────────────────────────────────────────────────────────────────

function SetRowEditor({
  index,
  row,
  weightPlaceholder,
  onChange,
  onRemove
}: {
  index: number
  row: SetRow
  /** "kg" / "kg/hand" / "kg total" — derived from the block's exercise
   *  equipment (see weightPlaceholderFor). */
  weightPlaceholder: string
  onChange: (patch: Partial<SetRow>) => void
  onRemove: () => void
}): ReactElement {
  return (
    <div className="gym-set-row">
      <span className="gym-set-index tabular-nums">{index + 1}</span>
      {/* One dose field plus the unit it counts in. A set is rep-counted or
          time-counted, so the unit is a switch rather than a rival input the
          user could fill in at the same time. */}
      <span className="gym-template-dose">
        <input
          className="gym-input gym-set-input gym-template-dose-input"
          type="number"
          aria-label={`Set ${index + 1} ${row.doseUnit === 'secs' ? 'hold in seconds' : 'reps'}`}
          min={row.doseUnit === 'secs' ? 1 : 0}
          placeholder={row.doseUnit === 'secs' ? 'secs' : 'reps'}
          value={(row.doseUnit === 'secs' ? row.durationS : row.reps) ?? ''}
          onChange={(e) => {
            const value = e.target.value === '' ? null : Number(e.target.value)
            onChange(row.doseUnit === 'secs' ? { durationS: value } : { reps: value })
          }}
        />
        <button
          type="button"
          className="gym-template-dose-unit"
          aria-label={`Set ${index + 1} dose unit: ${row.doseUnit === 'secs' ? 'seconds' : 'reps'} — click to switch`}
          title="Switch between reps and a timed hold"
          onClick={() =>
            onChange(
              row.doseUnit === 'secs'
                ? { doseUnit: 'reps', durationS: null }
                : { doseUnit: 'secs', reps: null }
            )
          }
        >
          {row.doseUnit === 'secs' ? 'secs' : 'reps'}
        </button>
      </span>
      <input
        className="gym-input gym-set-input"
        type="number"
        aria-label={`Set ${index + 1} load in kilograms`}
        min={0}
        // Never "kg (bw)": a blank here is an unrecorded weight as often as a
        // bodyweight one, and for that equipment the placeholder shouldn't
        // teach the reading that made a blank machine set look like a real
        // performance (agent_log #17). Where the equipment IS a loaded
        // implement, the placeholder instead teaches the entry convention —
        // one dumbbell's weight, not the pair's total — via weightPlaceholder.
        placeholder={weightPlaceholder}
        value={row.weightKg ?? ''}
        onChange={(e) =>
          onChange({ weightKg: e.target.value === '' ? null : Number(e.target.value) })
        }
      />
      <input
        className="gym-input gym-set-input gym-set-input--rpe"
        type="number"
        aria-label={`Set ${index + 1} RPE`}
        min="1"
        max="10"
        step="0.5"
        inputMode="decimal"
        placeholder="RPE"
        value={row.rpe ?? ''}
        onChange={(e) => onChange({ rpe: e.target.value === '' ? null : Number(e.target.value) })}
      />
      <input
        className="gym-input gym-set-note-input"
        type="text"
        aria-label={`Set ${index + 1} note`}
        maxLength={500}
        placeholder="Set note"
        value={row.note}
        onChange={(e) => onChange({ note: e.target.value })}
      />
      <label className="gym-check gym-set-warmup">
        <input
          className="gym-check-input"
          type="checkbox"
          checked={row.isWarmup}
          onChange={(e) =>
            // Warm-ups never persist as unilateral (blocksToNewSets forces
            // is_unilateral false for them) — clearing it here the moment a
            // set is marked warm-up keeps this checkbox from showing a
            // checked-but-inert state.
            onChange({
              isWarmup: e.target.checked,
              ...(e.target.checked ? { isUnilateral: false } : {})
            })
          }
        />
        <span className="gym-check-mark" aria-hidden="true" />
        Warm-up
      </label>
      <label
        className="gym-check gym-set-unilateral"
        title="Single-arm or single-leg set — overrides the exercise's default for just this set"
      >
        <input
          className="gym-check-input"
          type="checkbox"
          checked={row.isUnilateral}
          disabled={row.isWarmup}
          aria-label={`Set ${index + 1} unilateral (single-arm or single-leg)`}
          onChange={(e) => onChange({ isUnilateral: e.target.checked })}
        />
        <span className="gym-check-mark" aria-hidden="true" />
        Uni
      </label>
      <button type="button" className="gym-set-remove" aria-label="Remove set" onClick={onRemove}>
        ×
      </button>
    </div>
  )
}

// ── exercise block ───────────────────────────────────────────────────────────

function ExerciseBlockEditor({
  block,
  usage,
  lastHint,
  equipment,
  onChange,
  onRemove,
  onMove,
  onAddBelow,
  isFirst,
  isLast
}: {
  block: Block
  usage: Map<string, { count: number; lastIso: string | null }>
  lastHint: string | null
  /** The block's resolved exercise equipment, or null before one is picked —
   *  drives the weight input's placeholder (weightPlaceholderFor). */
  equipment: string | null
  onChange: (block: Block) => void
  onRemove: () => void
  onMove: (direction: 'up' | 'down') => void
  onAddBelow: () => void
  isFirst: boolean
  isLast: boolean
}): ReactElement {
  // The Sets/Reps quick-generator boxes have no state of their own — they
  // display a value *derived* from block.rows (uniformPrefillDose), so
  // +set/×-remove (which mutate rows directly) are reflected immediately.
  // While a field is focused we show the raw in-progress keystrokes instead
  // (draft), so the derivation doesn't fight a mid-edit value like "1" on
  // its way to "12"; on blur the field snaps back to the true derived count.
  const derivedDose = uniformPrefillDose(block.rows)
  const weightPlaceholder = weightPlaceholderFor(equipment)
  const eccentricState = blockEccentricState(block.rows)
  const eccentricCheckboxRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (eccentricCheckboxRef.current) {
      eccentricCheckboxRef.current.indeterminate = eccentricState === 'mixed'
    }
  }, [eccentricState])
  const unilateralState = blockUnilateralState(block.rows)
  const unilateralCheckboxRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (unilateralCheckboxRef.current) {
      unilateralCheckboxRef.current.indeterminate = unilateralState === 'mixed'
    }
  }, [unilateralState])
  const [setsDraft, setSetsDraft] = useState<string | null>(null)
  const [repsDraft, setRepsDraft] = useState<string | null>(null)
  const quickSets = quickSetFieldValue(setsDraft, derivedDose.sets)
  const quickReps = quickSetFieldValue(repsDraft, derivedDose.reps)
  const setExercise = (exercise: Exercise): void => {
    onChange({
      ...block,
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      // reverse flow: picking an exercise autofills the body-part filter
      bodyPartFilter: (exercise.body_part as GymBodyPart | null) ?? block.bodyPartFilter,
      rows: block.rows.map((r) => ({ ...r, exerciseId: exercise.id, exerciseName: exercise.name }))
    })
  }

  const updateRow = (rowKey: string, patch: Partial<SetRow>): void => {
    onChange({ ...block, rows: block.rows.map((r) => (r.key === rowKey ? { ...r, ...patch } : r)) })
  }

  const removeRow = (rowKey: string): void => {
    onChange({ ...block, rows: block.rows.filter((r) => r.key !== rowKey) })
  }

  const addSet = (): void => {
    const last = block.rows[block.rows.length - 1]
    const copy = last
      ? { ...last, key: nextKey(), rpe: null, note: '' }
      : blankRow(block.exerciseId ?? '', block.exerciseName)
    onChange({ ...block, rows: [...block.rows, copy] })
  }

  /** Returns whether the pair committed to rows — callers use this to decide
   *  whether it's now safe to release the fields' in-progress drafts (see
   *  shouldReleaseQuickSetDraftOnBlur's doc comment for why that matters). */
  const applyQuickSets = (setValue: string, repValue: string): boolean => {
    if (!block.exerciseId) return false
    const rows = buildQuickSetRows(
      block.exerciseId,
      block.exerciseName,
      Number(setValue),
      Number(repValue)
    )
    if (!rows) return false
    const eccentricFlags = eccentricFlagsForQuickSetRebuild(block.rows, rows.length)
    const unilateralFlags = unilateralFlagsForQuickSetRebuild(block.rows, rows.length)
    onChange({
      ...block,
      rows: rows.map((row, index) => ({
        ...row,
        key: nextKey(),
        // The Sets × Reps shortcut is rep-counted by construction.
        doseUnit: 'reps' as const,
        rpe: null,
        note: '',
        isEccentric: eccentricFlags[index],
        isUnilateral: unilateralFlags[index]
      }))
    })
    return true
  }

  return (
    <div className="gym-exercise-block">
      <div className="gym-exercise-block-head">
        <Dropdown
          ariaLabel="Filter by body part"
          value={block.bodyPartFilter ?? ''}
          options={BODY_PART_OPTIONS}
          align="left"
          onChange={(value) =>
            onChange({ ...block, bodyPartFilter: (value || null) as GymBodyPart | null })
          }
        />
        <ExercisePicker
          value={block.exerciseName}
          bodyPart={block.bodyPartFilter}
          usage={usage}
          onResolved={setExercise}
        />
        <div className="gym-exercise-block-actions" aria-label="Exercise order">
          <button
            type="button"
            className="gym-block-action"
            onClick={() => onMove('up')}
            disabled={isFirst}
            aria-label="Move exercise up"
          >
            ↑
          </button>
          <button
            type="button"
            className="gym-block-action"
            onClick={() => onMove('down')}
            disabled={isLast}
            aria-label="Move exercise down"
          >
            ↓
          </button>
          <button type="button" className="gym-block-action" onClick={onAddBelow}>
            Add exercise below
          </button>
        </div>
        <button
          type="button"
          className="gym-set-remove"
          aria-label="Remove exercise"
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {lastHint && <p className="gym-last-hint">{lastHint}</p>}
      <label className="gym-check gym-block-eccentric">
        <input
          ref={eccentricCheckboxRef}
          className="gym-check-input"
          type="checkbox"
          checked={eccentricState === true}
          onChange={(event) =>
            onChange({
              ...block,
              isEccentric: event.target.checked,
              rows: block.rows.map((row) => ({
                ...row,
                isEccentric: !row.isWarmup && event.target.checked
              }))
            })
          }
        />
        <span className="gym-check-mark" aria-hidden="true" />
        Eccentric
      </label>
      <label className="gym-check gym-block-unilateral">
        <input
          ref={unilateralCheckboxRef}
          className="gym-check-input"
          type="checkbox"
          checked={unilateralState === true}
          onChange={(event) =>
            onChange({
              ...block,
              isUnilateral: event.target.checked,
              rows: block.rows.map((row) => ({
                ...row,
                isUnilateral: !row.isWarmup && event.target.checked
              }))
            })
          }
        />
        <span className="gym-check-mark" aria-hidden="true" />
        Unilateral
      </label>
      <div className="gym-quick-sets" aria-label="Quick sets and reps">
        <label className="gym-quick-set-field">
          <span>Sets</span>
          <input
            className="gym-input gym-quick-set-input"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            placeholder="3"
            value={quickSets}
            onFocus={() => setSetsDraft(quickSets)}
            onChange={(event) => {
              const value = event.target.value
              setSetsDraft(value)
              // Once this pairs with Reps and commits, both boxes can safely
              // go back to tracking the derived value.
              if (applyQuickSets(value, quickReps)) {
                setSetsDraft(null)
                setRepsDraft(null)
              }
            }}
            onBlur={() =>
              setSetsDraft((draft) =>
                shouldReleaseQuickSetDraftOnBlur(draft, derivedDose.sets) ? null : draft
              )
            }
          />
        </label>
        <span className="gym-quick-set-times" aria-hidden="true">
          ×
        </span>
        <label className="gym-quick-set-field">
          <span>Reps</span>
          <input
            className="gym-input gym-quick-set-input"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            placeholder="8"
            value={quickReps}
            onFocus={() => setRepsDraft(quickReps)}
            onChange={(event) => {
              const value = event.target.value
              setRepsDraft(value)
              // Once this pairs with Sets and commits, both boxes can safely
              // go back to tracking the derived value.
              if (applyQuickSets(quickSets, value)) {
                setSetsDraft(null)
                setRepsDraft(null)
              }
            }}
            onBlur={() =>
              setRepsDraft((draft) =>
                shouldReleaseQuickSetDraftOnBlur(draft, derivedDose.reps) ? null : draft
              )
            }
          />
        </label>
        <span className="gym-quick-set-hint">updates rows automatically</span>
      </div>
      {block.rows.map((row, i) => (
        <SetRowEditor
          key={row.key}
          index={i}
          row={row}
          weightPlaceholder={weightPlaceholder}
          onChange={(patch) => updateRow(row.key, patch)}
          onRemove={() => removeRow(row.key)}
        />
      ))}
      <button type="button" className="gym-quiet-action gym-add-set" onClick={addSet}>
        + set
      </button>
    </div>
  )
}

// ── modal ────────────────────────────────────────────────────────────────────

export function SessionEditorModal({
  target,
  templates,
  recoveryTemplates = [],
  sessions,
  timezone,
  onClose,
  onSaved,
  embedded = false
}: {
  target: EditorTarget
  templates: GymTemplate[]
  recoveryTemplates?: RecoveryLogTemplate[]
  /** Already-fetched history (90d) — powers last-time hints + picker usage ranking. */
  sessions: GymSession[]
  timezone: string | null | undefined
  onClose: () => void
  onSaved?: () => void
  embedded?: boolean
}): ReactElement {
  const isEdit = target.kind === 'edit'
  const existingSession = target.kind === 'edit' ? target.session : null
  const linkedWorkout = target.kind === 'new-linked' ? target.workout : null
  const initialRecoveryTemplate =
    target.kind !== 'edit' && target.recoveryTemplateId
      ? (recoveryTemplates.find((template) => template.id === target.recoveryTemplateId) ?? null)
      : null
  const [baseUpdatedAt] = useState<string | null>(() => existingSession?.updated_at ?? null)
  const [restoredDraft] = useState<SessionDraft | null>(() => readDraft(target))

  const [title, setTitle] = useState(restoredDraft?.title ?? existingSession?.title ?? '')
  const [templateIds, setTemplateIds] = useState<string[]>(
    () =>
      restoredDraft?.templateIds ??
      existingSession?.template_ids ??
      (existingSession?.template_id ? [existingSession.template_id] : [])
  )
  const [recoveryTemplateIds, setRecoveryTemplateIds] = useState<string[]>(
    () =>
      restoredDraft?.recoveryTemplateIds ??
      (initialRecoveryTemplate ? [initialRecoveryTemplate.id] : [])
  )
  const [templateToAdd, setTemplateToAdd] = useState('')
  const [notes, setNotes] = useState(restoredDraft?.notes ?? existingSession?.notes ?? '')
  const [bodyParts, setBodyParts] = useState<GymBodyPart[]>(
    () => restoredDraft?.bodyParts ?? ((existingSession?.body_parts ?? []) as GymBodyPart[])
  )
  const [performedAt, setPerformedAt] = useState<string>(() => {
    if (restoredDraft) return restoredDraft.performedAt
    if (existingSession && !existingSession.workout_id)
      return formatZonedDateTimeLocal(existingSession.performed_at, timezone)
    return formatZonedDateTimeLocal(new Date().toISOString(), timezone)
  })
  const [blocks, setBlocks] = useState<Block[]>(() =>
    restoredDraft
      ? blocksFromDraft(restoredDraft.blocks)
      : existingSession
        ? blocksFromSession(existingSession)
        : blocksFromPrefill(initialRecoveryTemplate?.rows ?? [])
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showDiscardGuard, setShowDiscardGuard] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const discardDialogRef = useRef<HTMLDialogElement>(null)
  const primaryGuardActionRef = useRef<HTMLButtonElement>(null)
  const modalInitialFocusRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!embedded) modalInitialFocusRef.current?.focus()
  }, [embedded])

  const addMutation = useAddGymSession()
  // useUpdateGymSession/useDeleteGymSession take the session id up front so
  // their mutation scope can be keyed per-session (see useGymData.ts) — this
  // modal only ever edits/deletes existingSession, so the id is stable for
  // its lifetime. The sentinel covers new-session mode, where these two
  // mutations are simply never invoked (handleDelete/edit branch of
  // handleSave both guard on existingSession first).
  const updateMutation = useUpdateGymSession(existingSession?.id ?? 'new')
  const deleteMutation = useDeleteGymSession(existingSession?.id ?? 'new')

  const activeTemplates = templates.filter((t) => !t.archived)
  const isUnlinkedEdit = existingSession != null && existingSession.workout_id === null
  const showDateInput = target.kind === 'new-unlinked' || isUnlinkedEdit

  const pending = addMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  const draftKey = useMemo(() => draftStorageKey(target), [target])
  const currentDraft = useMemo(
    () =>
      serializeDraft(baseUpdatedAt, {
        title,
        templateIds,
        recoveryTemplateIds,
        notes,
        bodyParts,
        performedAt,
        blocks
      }),
    [
      baseUpdatedAt,
      title,
      templateIds,
      recoveryTemplateIds,
      notes,
      bodyParts,
      performedAt,
      blocks
    ]
  )
  const [cleanDraft] = useState(() => JSON.stringify(currentDraft))
  const isDirty = restoredDraft !== null || JSON.stringify(currentDraft) !== cleanDraft
  const latestDraftRef = useRef(currentDraft)
  const shouldFlushDraftRef = useRef(isDirty)
  latestDraftRef.current = currentDraft
  shouldFlushDraftRef.current = isDirty

  useEffect(() => {
    if (!isDirty) return
    try {
      localStorage.setItem(draftKey, JSON.stringify(currentDraft))
      setDraftSaved(true)
    } catch {
      // Saving remains available when local storage is unavailable.
    }
  }, [currentDraft, draftKey, isDirty])

  useEffect(() => {
    const dialog = discardDialogRef.current
    if (!dialog) return
    if (showDiscardGuard && !dialog.open) {
      dialog.showModal()
      primaryGuardActionRef.current?.focus()
    } else if (!showDiscardGuard && dialog.open) {
      dialog.close()
    }
  }, [showDiscardGuard])

  useEffect(() => {
    const flushDraftOnUnmount = (): void => {
      if (!shouldFlushDraftRef.current) return
      try {
        localStorage.setItem(draftKey, JSON.stringify(latestDraftRef.current))
      } catch {
        // Unmounting must never be blocked by an unavailable local cache.
      }
    }
    return flushDraftOnUnmount
  }, [draftKey])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!isDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  const clearDraft = (): void => {
    shouldFlushDraftRef.current = false
    try {
      localStorage.removeItem(draftKey)
    } catch {
      // A missing cache must not prevent closing the editor.
    }
    setDraftSaved(false)
  }

  const requestClose = useCallback((): void => {
    if (pending) return
    if (isDirty) {
      setShowDiscardGuard(true)
      return
    }
    onClose()
  }, [isDirty, onClose, pending])

  const discardDraft = (): void => {
    clearDraft()
    onClose()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const addTemplate = (): void => {
    if (templateToAdd.startsWith('gym:')) {
      const id = templateToAdd.slice(4)
      const template = templates.find((candidate) => candidate.id === id)
      if (!template) return
      setBlocks((previous) => [...previous, ...blocksFromPrefill(prefillFromTemplates([template]))])
      setTemplateIds((previous) =>
        previous.includes(template.id) ? previous : [...previous, template.id]
      )
    } else if (templateToAdd.startsWith('recovery:')) {
      const template = recoveryTemplates.find((candidate) => candidate.id === templateToAdd)
      if (!template) return
      setBlocks((previous) => [...previous, ...blocksFromPrefill(template.rows)])
      setRecoveryTemplateIds((previous) =>
        previous.includes(template.id) ? previous : [...previous, template.id]
      )
    } else {
      return
    }
    setTemplateToAdd('')
  }

  const removeTemplate = (templateId: string): void => {
    setTemplateIds((previous) => previous.filter((id) => id !== templateId))
  }

  const removeRecoveryTemplate = (templateId: string): void => {
    setRecoveryTemplateIds((previous) => previous.filter((id) => id !== templateId))
  }

  const addExerciseBlock = (): void => {
    setBlocks((prev) => [
      ...prev,
      {
        key: nextKey(),
        exerciseId: null,
        exerciseName: '',
        bodyPartFilter: null,
        isEccentric: false,
        isUnilateral: false,
        rows: [blankRow('', '')]
      }
    ])
  }

  const updateBlock = (key: string, block: Block): void => {
    setBlocks((prev) => prev.map((b) => (b.key === key ? block : b)))
  }

  const removeBlock = (key: string): void => {
    setBlocks((prev) => prev.filter((b) => b.key !== key))
  }

  const moveExerciseBlock = (key: string, direction: 'up' | 'down'): void => {
    setBlocks((previous) => moveBlock(previous, key, direction))
  }

  const addExerciseBelow = (key: string): void => {
    const block: Block = {
      key: nextKey(),
      exerciseId: null,
      exerciseName: '',
      bodyPartFilter: null,
      isEccentric: false,
      isUnilateral: false,
      rows: [blankRow('', '')]
    }
    setBlocks((previous) => insertBlockAfter(previous, key, block))
  }

  const setCount = useMemo(() => blocks.reduce((n, b) => n + b.rows.length, 0), [blocks])
  const hasIncompleteExercise = blocks.some((b) => !b.exerciseId)

  const exercisesQuery = useExercises()
  const exercisesById = useMemo(
    () => new Map((exercisesQuery.data ?? []).map((e) => [e.id, e])),
    [exercisesQuery.data]
  )
  const usage = useMemo(() => exerciseUsage(sessions), [sessions])
  // Each routine carries its OWN plan's week: a ramped item's frequency has to
  // be read against the plan it belongs to, and a log can pull from several.
  const recoveryRoutineItems = useMemo(
    () =>
      recoveryTemplateIds.flatMap((templateId) => {
        const template = recoveryTemplates.find((entry) => entry.id === templateId)
        if (!template) return []
        const planWeek = currentPlanWeek(template.planStartedAt, ymdKey(todayYMD(timezone)))
        return template.exerciseItems
          .filter((item) => item.steps != null && item.steps.length > 0)
          .map((item) => ({ item, planWeek, planStartedAt: template.planStartedAt }))
      }),
    [recoveryTemplateIds, recoveryTemplates, timezone]
  )

  // With set rows present the chips are display-only, derived from the blocks'
  // exercises; the freely-toggleable declared list only exists for set-less logs.
  const derivedParts = useMemo(
    () => derivedBodyParts(blocks, exercisesById),
    [blocks, exercisesById]
  )
  const chipsDerived = setCount > 0

  const toggleBodyPart = (part: GymBodyPart): void => {
    setBodyParts((prev) => (prev.includes(part) ? prev.filter((p) => p !== part) : [...prev, part]))
  }

  const lastHintFor = (block: Block): string | null => {
    if (!block.exerciseId) return null
    const last = lastPerformance(block.exerciseId, sessions, existingSession?.id ?? null)
    if (!last) return null
    const equipment = exercisesById.get(block.exerciseId)?.equipment ?? null
    return `Last: ${formatSetLine(last.sets, equipment)} — ${shortDate(last.performedAt)}`
  }

  const finishSave = (): void => {
    clearDraft()
    if (onSaved) onSaved()
    else onClose()
  }

  const handleSave = async (): Promise<void> => {
    setError(null)
    if (hasIncompleteExercise) {
      setError('Finish or remove the exercise row without a name.')
      return
    }
    const invalidSet = firstInvalidSetMessage(blocks)
    if (invalidSet) {
      setError(invalidSet)
      return
    }
    const sets = blocksToNewSets(blocks)
    const patchTitle = title.trim() || null
    const patchNotes = notes.trim() || null
    // Derived display beats stored declaration: with sets, persist null so a
    // stale body-part list can never disagree with the actual sets.
    const patchBodyParts = sets.length > 0 || bodyParts.length === 0 ? null : bodyParts
    let performedAtIso: string | null = null
    if (showDateInput) {
      try {
        performedAtIso = zonedDateTimeLocalToIso(performedAt, timezone)
      } catch {
        setError('Choose a valid date and time in your configured time zone.')
        return
      }
    }

    if (isEdit && existingSession) {
      try {
        await updateMutation.mutateAsync({
          id: existingSession.id,
          patch: {
            title: patchTitle,
            notes: patchNotes,
            template_ids: templateIds,
            body_parts: patchBodyParts,
            sets,
            ...(isUnlinkedEdit && performedAtIso !== null ? { performed_at: performedAtIso } : {})
          }
        })
        finishSave()
      } catch (err) {
        const detail = saveErrorDetail(err)
        setError(
          detail
            ? `Could not save changes (${detail}). Your draft is still saved locally.`
            : 'Could not save changes. Your draft is still saved locally.'
        )
      }
      return
    }

    const payload: NewGymSession = {
      title: patchTitle,
      notes: patchNotes,
      template_ids: templateIds,
      body_parts: patchBodyParts,
      sets
    }
    if (linkedWorkout) {
      payload.workout_id = linkedWorkout.id
      payload.performed_at = linkedWorkout.start_at
    } else if (performedAtIso !== null) {
      payload.performed_at = performedAtIso
    } else {
      setError('Choose a valid date and time in your configured time zone.')
      return
    }

    try {
      await addMutation.mutateAsync(payload)
      finishSave()
    } catch (err) {
      const detail = saveErrorDetail(err)
      setError(
        detail
          ? `Could not save the log (${detail}). Your draft is still saved locally.`
          : 'Could not save the log. Your draft is still saved locally.'
      )
    }
  }

  const saveFromDiscardGuard = (): void => {
    setShowDiscardGuard(false)
    void handleSave()
  }

  const handleDelete = async (): Promise<void> => {
    if (!existingSession) return
    try {
      await deleteMutation.mutateAsync(existingSession.id)
      clearDraft()
      onClose()
    } catch {
      setError('Could not delete the log. Please try again.')
    }
  }

  return (
    <div
      className={embedded ? 'gym-session-embedded' : 'gym-modal-overlay'}
      onClick={embedded ? undefined : requestClose}
    >
      <div
        className={
          embedded ? 'gym-session-embedded-form' : 'gym-modal gym-modal--wide gym-session-modal'
        }
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-label={isEdit ? 'Edit gym session' : 'Log gym session'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={embedded ? 'gym-modal-head gym-modal-head--embedded' : 'gym-modal-head'}>
          <h3
            className={
              embedded ? 'day-drawer-section-label gym-modal-title--embedded' : 'gym-modal-title'
            }
          >
            {isEdit ? 'Edit workout log' : 'Log session'}
          </h3>
          {!embedded && (
            <button
              type="button"
              className="gym-modal-close"
              ref={modalInitialFocusRef}
              aria-label="Close"
              onClick={requestClose}
            >
              ×
            </button>
          )}
        </div>

        <div className="gym-modal-body">
          {!embedded && (linkedWorkout || existingSession?.workout_id) && (
            <p className="gym-linked-summary">
              {linkedWorkout
                ? `Linked workout · ${formatLocalTime(linkedWorkout.start_at, timezone)} · ${formatDurationHM(linkedWorkout.duration_s ?? 0)}${linkedWorkout.avg_hr !== null ? ` · ${Math.round(linkedWorkout.avg_hr)} bpm` : ''}`
                : 'Linked to a synced workout'}
            </p>
          )}

          <label className="gym-field">
            <span className="gym-field-label">Title</span>
            <input
              className="gym-input"
              type="text"
              placeholder="e.g. Legs"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <div className="gym-field">
            <span className="gym-field-label">
              Body parts
              {chipsDerived && <span className="gym-field-label-note"> · derived from sets</span>}
            </span>
            <div className="gym-bodypart-chips">
              {chipsDerived
                ? // Derived: passive read-only tags, not toggle buttons — the
                  // form isn't "clicking its own buttons" as exercises fill
                  // in, it's reporting a fact. Parts with no sets simply
                  // don't render (nothing to mute-and-show).
                  derivedParts.map((part) => (
                    <span
                      key={part}
                      className="gym-bodypart-chip gym-bodypart-chip--derived"
                      aria-disabled="true"
                    >
                      {displayBodyPart(part)}
                    </span>
                  ))
                : GYM_BODY_PARTS.map((part) => {
                    const active = bodyParts.includes(part)
                    const className = [
                      'gym-bodypart-chip',
                      active ? 'gym-bodypart-chip--active' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')
                    return (
                      <button
                        key={part}
                        type="button"
                        className={className}
                        aria-pressed={active}
                        onClick={() => toggleBodyPart(part)}
                      >
                        {displayBodyPart(part)}
                      </button>
                    )
                  })}
            </div>
            {!chipsDerived && setCount === 0 && (
              <p className="gym-quicklog-hint">
                Tap what you trained and save — that alone is a valid log.
              </p>
            )}
            {chipsDerived && derivedParts.length === 0 && (
              <p className="gym-quicklog-hint">
                No body parts yet — pick an exercise with one on record.
              </p>
            )}
          </div>

          {showDateInput && (
            <label className="gym-field">
              <span className="gym-field-label">Date &amp; time</span>
              <input
                className="gym-input"
                type="datetime-local"
                value={performedAt}
                onChange={(e) => setPerformedAt(e.target.value)}
              />
            </label>
          )}

          <div className="gym-field">
            <span className="gym-field-label">Add template</span>
            <div className="gym-template-select-row">
              <Dropdown
                ariaLabel="Template to add"
                value={templateToAdd}
                options={[
                  { value: '', label: 'Choose a template' },
                  ...activeTemplates
                    .filter((template) => !templateIds.includes(template.id))
                    .map((template) => ({
                      value: `gym:${template.id}`,
                      label: `Template · ${template.name}`
                    })),
                  ...recoveryTemplates
                    .filter(
                      (template) =>
                        template.rows.length > 0 && !recoveryTemplateIds.includes(template.id)
                    )
                    .map((template) => ({
                      value: template.id,
                      label: `Recovery · ${template.name}`
                    }))
                ]}
                align="left"
                onChange={setTemplateToAdd}
              />
              <button
                type="button"
                className="gym-btn"
                onClick={addTemplate}
                disabled={!templateToAdd}
              >
                Add exercises
              </button>
            </div>
            {(templateIds.length > 0 || recoveryTemplateIds.length > 0) && (
              <div className="gym-template-chips" aria-label="Applied templates">
                {templateIds.map((templateId) => {
                  const name =
                    templates.find((template) => template.id === templateId)?.name ?? 'Template'
                  return (
                    <span key={templateId} className="gym-template-chip">
                      {name}
                      <button
                        type="button"
                        className="gym-template-chip-remove"
                        aria-label={`Remove ${name} template`}
                        onClick={() => removeTemplate(templateId)}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
                {recoveryTemplateIds.map((templateId) => {
                  const name =
                    recoveryTemplates.find((template) => template.id === templateId)?.name ??
                    'Recovery plan'
                  return (
                    <span
                      key={templateId}
                      className="gym-template-chip gym-template-chip--recovery"
                    >
                      {name}
                      <button
                        type="button"
                        className="gym-template-chip-remove"
                        aria-label={`Remove ${name} recovery template`}
                        onClick={() => removeRecoveryTemplate(templateId)}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            <p className="gym-quicklog-hint">
              Add as many templates as you need. Their exercises append in order and remain
              editable.
            </p>
          </div>

          {recoveryRoutineItems.length > 0 && (
            <section
              className="gym-recovery-routines"
              aria-labelledby="gym-recovery-routines-title"
            >
              <div className="gym-recovery-routines-head">
                <div>
                  <span className="gym-field-label">Recovery plan</span>
                  <h4 id="gym-recovery-routines-title">Recovery routines</h4>
                </div>
                <span>Complete alongside the logged exercises</span>
              </div>
              {recoveryRoutineItems.map(({ item, planWeek, planStartedAt }) => {
                const weeklyTarget = resolveItemTargets(item, planWeek, planStartedAt).weekly_target
                return (
                  <article className="gym-recovery-routine" key={item.id}>
                    <div className="gym-recovery-routine-title">
                      <div>
                        <strong>{item.name}</strong>
                        {item.note && <p>{item.note}</p>}
                      </div>
                      {weeklyTarget != null && (
                        <span className="tabular-nums">{weeklyTarget}× / week</span>
                      )}
                    </div>
                    <RecoveryRoutineTable item={item} />
                  </article>
                )
              })}
            </section>
          )}

          <div className="gym-exercise-blocks">
            {blocks.map((block, index) => (
              <ExerciseBlockEditor
                key={block.key}
                block={block}
                usage={usage}
                lastHint={lastHintFor(block)}
                equipment={
                  block.exerciseId ? (exercisesById.get(block.exerciseId)?.equipment ?? null) : null
                }
                onChange={(b) => updateBlock(block.key, b)}
                onRemove={() => removeBlock(block.key)}
                onMove={(direction) => moveExerciseBlock(block.key, direction)}
                onAddBelow={() => addExerciseBelow(block.key)}
                isFirst={index === 0}
                isLast={index === blocks.length - 1}
              />
            ))}
          </div>

          <button type="button" className="gym-quiet-action" onClick={addExerciseBlock}>
            + exercise
          </button>

          <label className="gym-field">
            <span className="gym-field-label">Notes</span>
            <textarea
              className="gym-textarea"
              rows={3}
              placeholder="Optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          {error && <p className="gym-error" role="alert">{error}</p>}
          {draftSaved && (
            <p className="gym-draft-status" role="status">
              Draft saved locally
            </p>
          )}

          <div className="gym-modal-actions">
            <button
              type="button"
              className="gym-btn gym-btn--primary"
              disabled={pending}
              onClick={handleSave}
            >
              {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Save log'}
            </button>
            <button type="button" className="gym-btn" onClick={requestClose} disabled={pending}>
              Cancel
            </button>
            {isEdit && (
              <div className="gym-delete-zone">
                {!confirmDelete ? (
                  <button
                    type="button"
                    className="gym-btn gym-btn--danger"
                    onClick={() => setConfirmDelete(true)}
                    disabled={pending}
                  >
                    Delete
                  </button>
                ) : (
                  <>
                    <span className="gym-delete-confirm-label">Delete this log?</span>
                    <button
                      type="button"
                      className="gym-btn gym-btn--danger"
                      onClick={handleDelete}
                      disabled={pending}
                    >
                      {deleteMutation.isPending ? 'Deleting…' : 'Confirm delete'}
                    </button>
                    <button
                      type="button"
                      className="gym-btn"
                      onClick={() => setConfirmDelete(false)}
                      disabled={pending}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <dialog
            ref={discardDialogRef}
            className="gym-discard-guard"
            aria-label="Unsaved changes"
            onCancel={(event) => {
              event.preventDefault()
              setShowDiscardGuard(false)
            }}
          >
            {showDiscardGuard && (
              <>
                <p>Save your changes before closing?</p>
                <div className="gym-discard-guard-actions">
                  <button
                    ref={primaryGuardActionRef}
                    type="button"
                    className="gym-btn gym-btn--primary"
                    onClick={saveFromDiscardGuard}
                    disabled={pending}
                  >
                    Save {isEdit ? 'changes' : 'log'}
                  </button>
                  <button
                    type="button"
                    className="gym-btn"
                    onClick={discardDraft}
                    disabled={pending}
                  >
                    Discard draft
                  </button>
                  <button
                    type="button"
                    className="gym-btn"
                    onClick={() => setShowDiscardGuard(false)}
                    disabled={pending}
                  >
                    Keep editing
                  </button>
                </div>
              </>
            )}
          </dialog>
        </div>
      </div>
    </div>
  )
}
