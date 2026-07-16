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
import { formatLocalTime } from '../../hooks/sessionsDate'
import type { RecoveryLogTemplate } from '../../lib/recoveryLogTemplates'
import { Dropdown } from '../../components/Dropdown'
import { RecoveryRoutineTable } from '../../components/RecoveryPlanDetail'
import { ExercisePicker } from './ExercisePicker'
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
      <label className="gym-check gym-set-warmup">
        <input
          className="gym-check-input"
          type="checkbox"
          checked={row.isWarmup}
          onChange={(e) => onChange({ isWarmup: e.target.checked })}
        />
        <span className="gym-check-mark" aria-hidden="true" />
        Warm-up
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
  const initialDose = uniformPrefillDose(block.rows)
  const [quickSets, setQuickSets] = useState(initialDose.sets)
  const [quickReps, setQuickReps] = useState(initialDose.reps)
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

  const applyQuickSets = (setValue: string, repValue: string): void => {
    if (!block.exerciseId) return
    const rows = buildQuickSetRows(
      block.exerciseId,
      block.exerciseName,
      Number(setValue),
      Number(repValue)
    )
    if (!rows) return
    onChange({
      ...block,
      rows: rows.map((row) => ({ ...row, key: nextKey() }))
    })
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
        <button type="button" className="gym-set-remove" aria-label="Remove exercise" onClick={onRemove}>
          ×
        </button>
      </div>
      {lastHint && <p className="gym-last-hint">{lastHint}</p>}
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
            onChange={(event) => {
              const value = event.target.value
              setQuickSets(value)
              applyQuickSets(value, quickReps)
            }}
          />
        </label>
        <span className="gym-quick-set-times" aria-hidden="true">×</span>
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
            onChange={(event) => {
              const value = event.target.value
              setQuickReps(value)
              applyQuickSets(quickSets, value)
            }}
          />
        </label>
        <span className="gym-quick-set-hint">updates rows automatically</span>
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
      ? recoveryTemplates.find((template) => template.id === target.recoveryTemplateId) ?? null
      : null

  const [title, setTitle] = useState(existingSession?.title ?? '')
  const [templateIds, setTemplateIds] = useState<string[]>(() =>
    existingSession?.template_ids ?? (existingSession?.template_id ? [existingSession.template_id] : [])
  )
  const [recoveryTemplateIds, setRecoveryTemplateIds] = useState<string[]>(() =>
    initialRecoveryTemplate ? [initialRecoveryTemplate.id] : []
  )
  const [templateToAdd, setTemplateToAdd] = useState('')
  const [notes, setNotes] = useState(existingSession?.notes ?? '')
  const [bodyParts, setBodyParts] = useState<GymBodyPart[]>(
    () => (existingSession?.body_parts ?? []) as GymBodyPart[]
  )
  const [performedAt, setPerformedAt] = useState<string>(() => {
    if (existingSession && !existingSession.workout_id) return existingSession.performed_at.slice(0, 16)
    return new Date().toISOString().slice(0, 16)
  })
  const [blocks, setBlocks] = useState<Block[]>(() =>
    existingSession
      ? blocksFromSession(existingSession)
      : blocksFromPrefill(initialRecoveryTemplate?.rows ?? [])
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addMutation = useAddGymSession()
  // useUpdateGymSession/useDeleteGymSession take the session id up front so
  // their mutation scope can be keyed per-session (see useGymData.ts) — this
  // modal only ever edits/deletes existingSession, so the id is stable for
  // its lifetime. The sentinel covers new-session mode, where these two
  // mutations are simply never invoked (handleDelete/edit branch of
  // handleSave both guard on existingSession first).
  const updateMutation = useUpdateGymSession(existingSession?.id ?? 'new')
  const deleteMutation = useDeleteGymSession(existingSession?.id ?? 'new')

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

  const addTemplate = (): void => {
    if (templateToAdd.startsWith('gym:')) {
      const id = templateToAdd.slice(4)
      const template = templates.find((candidate) => candidate.id === id)
      if (!template) return
      setBlocks((previous) => [
        ...previous,
        ...blocksFromPrefill(prefillFromTemplates([template]))
      ])
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
  const recoveryRoutineItems = useMemo(
    () => recoveryTemplateIds.flatMap((templateId) =>
      recoveryTemplates
        .find((template) => template.id === templateId)
        ?.exerciseItems.filter((item) => item.steps != null && item.steps.length > 0) ?? []
    ),
    [recoveryTemplateIds, recoveryTemplates]
  )

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

  const finishSave = (): void => {
    if (onSaved) onSaved()
    else onClose()
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
            template_ids: templateIds,
            body_parts: patchBodyParts,
            sets
          }
        }
      )
      finishSave()
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
    } else {
      payload.performed_at = new Date(performedAt).toISOString()
    }

    addMutation.mutate(payload)
    finishSave()
  }

  const handleDelete = (): void => {
    if (!existingSession) return
    deleteMutation.mutate(existingSession.id)
    onClose()
  }

  return (
    <div
      className={embedded ? 'gym-session-embedded' : 'gym-modal-overlay'}
      onClick={embedded ? undefined : onClose}
    >
      <div
        className={
          embedded
            ? 'gym-session-embedded-form'
            : 'gym-modal gym-modal--wide gym-session-modal'
        }
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-label={isEdit ? 'Edit gym session' : 'Log gym session'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={embedded ? 'gym-modal-head gym-modal-head--embedded' : 'gym-modal-head'}>
          <h3 className={embedded ? 'day-drawer-section-label gym-modal-title--embedded' : 'gym-modal-title'}>
            {isEdit ? 'Edit workout log' : 'Log session'}
          </h3>
          {!embedded && (
            <button type="button" className="gym-modal-close" aria-label="Close" onClick={onClose}>
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
                  const name = templates.find((template) => template.id === templateId)?.name ?? 'Template'
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
                    <span key={templateId} className="gym-template-chip gym-template-chip--recovery">
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
              Add as many templates as you need. Their exercises append in order and remain editable.
            </p>
          </div>

          {recoveryRoutineItems.length > 0 && (
            <section className="gym-recovery-routines" aria-labelledby="gym-recovery-routines-title">
              <div className="gym-recovery-routines-head">
                <div>
                  <span className="gym-field-label">Recovery plan</span>
                  <h4 id="gym-recovery-routines-title">Recovery routines</h4>
                </div>
                <span>Complete alongside the logged exercises</span>
              </div>
              {recoveryRoutineItems.map((item) => (
                <article className="gym-recovery-routine" key={item.id}>
                  <div className="gym-recovery-routine-title">
                    <div><strong>{item.name}</strong>{item.note && <p>{item.note}</p>}</div>
                    {item.weekly_target != null && <span className="tabular-nums">{item.weekly_target}× / week</span>}
                  </div>
                  <RecoveryRoutineTable item={item} />
                </article>
              ))}
            </section>
          )}

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
              {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Save log'}
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
