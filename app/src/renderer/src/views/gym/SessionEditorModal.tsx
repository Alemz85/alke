// The Gym tab's core interaction: log or edit a session. Handles both "quick
// log" (title/template/notes only, zero set rows) and "full log" (exercise
// blocks with per-set reps/kg/warmup) — dual granularity is a data shape, not
// a UI mode, so both are the same form with the set editor optionally empty.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
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
  exerciseUsage,
  formatSetLine,
  groupSetsIntoBlocks,
  lastPerformance,
  prefillFromTemplate,
  type PrefillSetRow
} from '../../lib/gymLog'
import { formatDurationHM } from '../../lib/format'
import { formatLocalTime } from '../../hooks/sessionsDate'
import { ExercisePicker } from './ExercisePicker'
import '../GymView.css'

/** "Jul 7" — matches GymView's row date style. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export type EditorTarget =
  | { kind: 'new-linked'; workout: Workout }
  | { kind: 'new-unlinked' }
  | { kind: 'edit'; session: GymSession }

interface SetRow extends PrefillSetRow {
  key: string
}

interface Block {
  key: string
  exerciseId: string | null
  exerciseName: string
  // UI-only picker filter ("body part first, then the suggestions narrow");
  // autofilled in reverse when a picked exercise carries a body_part.
  bodyPartFilter: GymBodyPart | null
  rows: SetRow[]
}

let rowKeySeq = 0
function nextKey(): string {
  rowKeySeq += 1
  return `row-${rowKeySeq}`
}

function blankRow(exerciseId: string, exerciseName: string): SetRow {
  return { key: nextKey(), exerciseId, exerciseName, reps: null, weightKg: null, isWarmup: false }
}

function blocksFromSession(session: GymSession): Block[] {
  return groupSetsIntoBlocks(session.sets).map((b) => ({
    key: nextKey(),
    exerciseId: b.exerciseId,
    exerciseName: b.exerciseName,
    bodyPartFilter: null,
    rows: b.sets.map((s) => ({
      key: nextKey(),
      exerciseId: s.exercise_id,
      exerciseName: s.exercise_name,
      reps: s.reps,
      weightKg: s.weight_kg,
      isWarmup: s.is_warmup
    }))
  }))
}

function blocksFromPrefill(rows: PrefillSetRow[]): Block[] {
  const blocks: Block[] = []
  for (const row of rows) {
    const last = blocks[blocks.length - 1]
    if (last && last.exerciseId === row.exerciseId) {
      last.rows.push({ ...row, key: nextKey() })
    } else {
      blocks.push({
        key: nextKey(),
        exerciseId: row.exerciseId,
        exerciseName: row.exerciseName,
        bodyPartFilter: null,
        rows: [{ ...row, key: nextKey() }]
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
        reps: row.reps,
        weight_kg: row.weightKg,
        is_warmup: row.isWarmup
      })
    }
  }
  return out
}

// ── set row ──────────────────────────────────────────────────────────────────

function SetRowEditor({
  index,
  row,
  onChange,
  onRemove
}: {
  index: number
  row: SetRow
  onChange: (patch: Partial<SetRow>) => void
  onRemove: () => void
}): ReactElement {
  return (
    <div className="gym-set-row">
      <span className="gym-set-index tabular-nums">{index + 1}</span>
      <input
        className="gym-input gym-set-input"
        type="number"
        placeholder="reps"
        value={row.reps ?? ''}
        onChange={(e) => onChange({ reps: e.target.value === '' ? null : Number(e.target.value) })}
      />
      <input
        className="gym-input gym-set-input"
        type="number"
        placeholder="kg (bw)"
        value={row.weightKg ?? ''}
        onChange={(e) => onChange({ weightKg: e.target.value === '' ? null : Number(e.target.value) })}
      />
      <label className="gym-set-warmup">
        <input
          type="checkbox"
          checked={row.isWarmup}
          onChange={(e) => onChange({ isWarmup: e.target.checked })}
        />
        warmup
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
  onChange,
  onRemove
}: {
  block: Block
  usage: Map<string, { count: number; lastIso: string | null }>
  lastHint: string | null
  onChange: (block: Block) => void
  onRemove: () => void
}): ReactElement {
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
      ? { ...last, key: nextKey() }
      : blankRow(block.exerciseId ?? '', block.exerciseName)
    onChange({ ...block, rows: [...block.rows, copy] })
  }

  return (
    <div className="gym-exercise-block">
      <div className="gym-exercise-block-head">
        <select
          className="gym-input gym-bodypart-select"
          aria-label="Filter by body part"
          value={block.bodyPartFilter ?? ''}
          onChange={(e) =>
            onChange({ ...block, bodyPartFilter: (e.target.value || null) as GymBodyPart | null })
          }
        >
          <option value="">any</option>
          {GYM_BODY_PARTS.map((part) => (
            <option key={part} value={part}>
              {part}
            </option>
          ))}
        </select>
        <ExercisePicker
          value={block.exerciseName}
          bodyPart={block.bodyPartFilter}
          usage={usage}
          onResolved={setExercise}
        />
        <button type="button" className="gym-set-remove" aria-label="Remove exercise" onClick={onRemove}>
          ×
        </button>
      </div>
      {lastHint && <p className="gym-last-hint">{lastHint}</p>}
      {block.rows.map((row, i) => (
        <SetRowEditor
          key={row.key}
          index={i}
          row={row}
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
  sessions,
  timezone,
  onClose
}: {
  target: EditorTarget
  templates: GymTemplate[]
  /** Already-fetched history (90d) — powers last-time hints + picker usage ranking. */
  sessions: GymSession[]
  timezone: string | null | undefined
  onClose: () => void
}): ReactElement {
  const isEdit = target.kind === 'edit'
  const existingSession = target.kind === 'edit' ? target.session : null
  const linkedWorkout = target.kind === 'new-linked' ? target.workout : null

  const [title, setTitle] = useState(existingSession?.title ?? '')
  const [templateId, setTemplateId] = useState<string | null>(existingSession?.template_id ?? null)
  const [notes, setNotes] = useState(existingSession?.notes ?? '')
  const [bodyParts, setBodyParts] = useState<GymBodyPart[]>(
    () => (existingSession?.body_parts ?? []) as GymBodyPart[]
  )
  const [performedAt, setPerformedAt] = useState<string>(() => {
    if (existingSession && !existingSession.workout_id) return existingSession.performed_at.slice(0, 16)
    return new Date().toISOString().slice(0, 16)
  })
  const [blocks, setBlocks] = useState<Block[]>(() =>
    existingSession ? blocksFromSession(existingSession) : []
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addMutation = useAddGymSession()
  const updateMutation = useUpdateGymSession()
  const deleteMutation = useDeleteGymSession()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const activeTemplates = templates.filter((t) => !t.archived)
  const isUnlinkedEdit = existingSession != null && existingSession.workout_id === null
  const showDateInput = target.kind === 'new-unlinked' || isUnlinkedEdit

  const pending = addMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  const applyPrefill = (): void => {
    const t = templates.find((tp) => tp.id === templateId)
    if (!t) return
    setBlocks(blocksFromPrefill(prefillFromTemplate(t)))
  }

  const addExerciseBlock = (): void => {
    setBlocks((prev) => [
      ...prev,
      { key: nextKey(), exerciseId: null, exerciseName: '', bodyPartFilter: null, rows: [blankRow('', '')] }
    ])
  }

  const updateBlock = (key: string, block: Block): void => {
    setBlocks((prev) => prev.map((b) => (b.key === key ? block : b)))
  }

  const removeBlock = (key: string): void => {
    setBlocks((prev) => prev.filter((b) => b.key !== key))
  }

  const setCount = useMemo(() => blocks.reduce((n, b) => n + b.rows.length, 0), [blocks])
  const hasIncompleteExercise = blocks.some((b) => !b.exerciseId)

  const exercisesQuery = useExercises()
  const exercisesById = useMemo(
    () => new Map((exercisesQuery.data ?? []).map((e) => [e.id, e])),
    [exercisesQuery.data]
  )
  const usage = useMemo(() => exerciseUsage(sessions), [sessions])

  // With set rows present the chips are display-only, derived from the blocks'
  // exercises; the freely-toggleable declared list only exists for set-less logs.
  const derivedParts = useMemo(() => {
    const found = new Set<string>()
    for (const block of blocks) {
      if (!block.exerciseId) continue
      const part = exercisesById.get(block.exerciseId)?.body_part
      if (part) found.add(part)
    }
    return GYM_BODY_PARTS.filter((p) => found.has(p))
  }, [blocks, exercisesById])
  const chipsDerived = setCount > 0

  const toggleBodyPart = (part: GymBodyPart): void => {
    setBodyParts((prev) =>
      prev.includes(part) ? prev.filter((p) => p !== part) : [...prev, part]
    )
  }

  const lastHintFor = (block: Block): string | null => {
    if (!block.exerciseId) return null
    const last = lastPerformance(block.exerciseId, sessions, existingSession?.id ?? null)
    if (!last) return null
    return `Last: ${formatSetLine(last.sets)} — ${shortDate(last.performedAt)}`
  }

  const handleSave = (): void => {
    setError(null)
    if (hasIncompleteExercise) {
      setError('Finish or remove the exercise row without a name.')
      return
    }
    const sets = blocksToNewSets(blocks)
    const patchTitle = title.trim() || null
    const patchNotes = notes.trim() || null
    // Derived display beats stored declaration: with sets, persist null so a
    // stale body-part list can never disagree with the actual sets.
    const patchBodyParts = sets.length > 0 || bodyParts.length === 0 ? null : bodyParts

    if (isEdit && existingSession) {
      updateMutation.mutate(
        {
          id: existingSession.id,
          patch: {
            title: patchTitle,
            notes: patchNotes,
            template_id: templateId,
            body_parts: patchBodyParts,
            sets
          }
        },
        {
          onSuccess: () => onClose(),
          onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.')
        }
      )
      return
    }

    const payload: NewGymSession = {
      title: patchTitle,
      notes: patchNotes,
      template_id: templateId,
      body_parts: patchBodyParts,
      sets
    }
    if (linkedWorkout) {
      payload.workout_id = linkedWorkout.id
    } else {
      payload.performed_at = new Date(performedAt).toISOString()
    }

    addMutation.mutate(payload, {
      onSuccess: () => onClose(),
      onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.')
    })
  }

  const handleDelete = (): void => {
    if (!existingSession) return
    deleteMutation.mutate(existingSession.id, {
      onSuccess: () => onClose(),
      onError: (err) => setError(err instanceof Error ? err.message : 'Could not delete.')
    })
  }

  return (
    <div className="gym-modal-overlay" onClick={onClose}>
      <div
        className="gym-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit gym session' : 'Log gym session'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gym-modal-head">
          <h3 className="gym-modal-title">{isEdit ? 'Edit session' : 'Log session'}</h3>
          <button type="button" className="gym-modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="gym-modal-body">
          {(linkedWorkout || existingSession?.workout_id) && (
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
              {GYM_BODY_PARTS.map((part) => {
                const active = chipsDerived ? derivedParts.includes(part) : bodyParts.includes(part)
                const className = [
                  'gym-bodypart-chip',
                  active ? 'gym-bodypart-chip--active' : '',
                  chipsDerived ? 'gym-bodypart-chip--derived' : ''
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <button
                    key={part}
                    type="button"
                    className={className}
                    aria-pressed={active}
                    disabled={chipsDerived}
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

          <label className="gym-field">
            <span className="gym-field-label">Template</span>
            <div className="gym-template-select-row">
              <select
                className="gym-input"
                value={templateId ?? ''}
                onChange={(e) => setTemplateId(e.target.value || null)}
              >
                <option value="">No template</option>
                {activeTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {templateId && (
                <button type="button" className="gym-quiet-action" onClick={applyPrefill}>
                  Prefill sets
                </button>
              )}
            </div>
          </label>

          <div className="gym-exercise-blocks">
            {blocks.map((block) => (
              <ExerciseBlockEditor
                key={block.key}
                block={block}
                usage={usage}
                lastHint={lastHintFor(block)}
                onChange={(b) => updateBlock(block.key, b)}
                onRemove={() => removeBlock(block.key)}
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

          {error && <p className="gym-error">{error}</p>}

          <div className="gym-modal-actions">
            <button type="button" className="gym-btn gym-btn--primary" disabled={pending} onClick={handleSave}>
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="gym-btn" onClick={onClose} disabled={pending}>
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
                    <button type="button" className="gym-btn" onClick={() => setConfirmDelete(false)} disabled={pending}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
