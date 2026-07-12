// The Gym tab's core interaction: log or edit a session. Handles both "quick
// log" (title/template/notes only, zero set rows) and "full log" (exercise
// blocks with per-set reps/kg/warmup) — dual granularity is a data shape, not
// a UI mode, so both are the same form with the set editor optionally empty.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { GymSession, GymTemplate, NewGymSession, Workout } from '@shared/types'
import {
  useAddExercise,
  useAddGymSession,
  useDeleteGymSession,
  useExercises,
  useUpdateGymSession
} from '../../hooks/useGymData'
import { groupSetsIntoBlocks, prefillFromTemplate, type PrefillSetRow } from '../../lib/gymLog'
import { formatDurationHM } from '../../lib/format'
import { formatLocalTime } from '../../hooks/sessionsDate'
import '../GymView.css'

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

// ── exercise picker (create-on-type) ────────────────────────────────────────

function ExercisePicker({
  value,
  onResolved
}: {
  value: string
  onResolved: (id: string, name: string) => void
}): ReactElement {
  const exercisesQuery = useExercises()
  const addExercise = useAddExercise()
  const exercises = exercisesQuery.data ?? []
  const [text, setText] = useState(value)

  useEffect(() => setText(value), [value])

  const commit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    const existing = exercises.find((e) => e.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) {
      onResolved(existing.id, existing.name)
      return
    }
    addExercise.mutate(
      { name: trimmed, muscleGroup: null },
      { onSuccess: (created) => onResolved(created.id, created.name) }
    )
  }

  return (
    <>
      <input
        className="gym-input gym-exercise-input"
        type="text"
        list="gym-exercise-catalog"
        placeholder="Exercise"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
      <datalist id="gym-exercise-catalog">
        {exercises.map((ex) => (
          <option key={ex.id} value={ex.name} />
        ))}
      </datalist>
    </>
  )
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
  onChange,
  onRemove
}: {
  block: Block
  onChange: (block: Block) => void
  onRemove: () => void
}): ReactElement {
  const setExercise = (id: string, name: string): void => {
    onChange({ ...block, exerciseId: id, exerciseName: name, rows: block.rows.map((r) => ({ ...r, exerciseId: id, exerciseName: name })) })
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
        <ExercisePicker value={block.exerciseName} onResolved={setExercise} />
        <button type="button" className="gym-set-remove" aria-label="Remove exercise" onClick={onRemove}>
          ×
        </button>
      </div>
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
  timezone,
  onClose
}: {
  target: EditorTarget
  templates: GymTemplate[]
  timezone: string | null | undefined
  onClose: () => void
}): ReactElement {
  const isEdit = target.kind === 'edit'
  const existingSession = target.kind === 'edit' ? target.session : null
  const linkedWorkout = target.kind === 'new-linked' ? target.workout : null

  const [title, setTitle] = useState(existingSession?.title ?? '')
  const [templateId, setTemplateId] = useState<string | null>(existingSession?.template_id ?? null)
  const [notes, setNotes] = useState(existingSession?.notes ?? '')
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
    setBlocks((prev) => [...prev, { key: nextKey(), exerciseId: null, exerciseName: '', rows: [blankRow('', '')] }])
  }

  const updateBlock = (key: string, block: Block): void => {
    setBlocks((prev) => prev.map((b) => (b.key === key ? block : b)))
  }

  const removeBlock = (key: string): void => {
    setBlocks((prev) => prev.filter((b) => b.key !== key))
  }

  const setCount = useMemo(() => blocks.reduce((n, b) => n + b.rows.length, 0), [blocks])
  const hasIncompleteExercise = blocks.some((b) => !b.exerciseId)

  const handleSave = (): void => {
    setError(null)
    if (hasIncompleteExercise) {
      setError('Finish or remove the exercise row without a name.')
      return
    }
    const sets = blocksToNewSets(blocks)
    const patchTitle = title.trim() || null
    const patchNotes = notes.trim() || null

    if (isEdit && existingSession) {
      updateMutation.mutate(
        {
          id: existingSession.id,
          patch: { title: patchTitle, notes: patchNotes, template_id: templateId, sets }
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
                onChange={(b) => updateBlock(block.key, b)}
                onRemove={() => removeBlock(block.key)}
              />
            ))}
          </div>

          <button type="button" className="gym-quiet-action" onClick={addExerciseBlock}>
            + exercise
          </button>

          {setCount === 0 && (
            <p className="gym-quicklog-hint">Saving without sets records a quick log.</p>
          )}

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
