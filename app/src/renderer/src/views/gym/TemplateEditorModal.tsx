// Template create/edit modal: name, notes, an ordered item list (exercise +
// optional targets), and an archive toggle for existing templates.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { GYM_BODY_PARTS, type Exercise, type GymBodyPart, type GymTemplate, type NewGymTemplateItem } from '@shared/types'
import { useAddGymTemplate, useCreateGymTemplateVersion, useExercises, useUpdateGymTemplate } from '../../hooks/useGymData'
import { Dropdown } from '../../components/Dropdown'
import { formatRest } from '../../lib/gymLog'
import { ExercisePicker } from './ExercisePicker'

const BODY_PART_OPTIONS = [
  { value: '', label: 'any' },
  ...GYM_BODY_PARTS.map((p) => ({ value: p, label: p }))
]
import '../GymView.css'

export interface ItemRow {
  key: string
  exerciseId: string | null
  exerciseName: string
  // UI-only picker filter, autofilled back from a picked exercise's body_part.
  bodyPartFilter: GymBodyPart | null
  targetSets: string
  targetReps: string
  targetWeightKg: string
  // Per-exercise rest override (seconds); blank = use the template default.
  restAfterSeconds: string
  note: string
}

let itemKeySeq = 0
function nextItemKey(): string {
  itemKeySeq += 1
  return `item-${itemKeySeq}`
}

function blankItem(): ItemRow {
  return {
    key: nextItemKey(),
    exerciseId: null,
    exerciseName: '',
    bodyPartFilter: null,
    targetSets: '',
    targetReps: '',
    targetWeightKg: '',
    restAfterSeconds: '',
    note: ''
  }
}

/**
 * Seeds the editor rows from a saved template. bodyPartFilter is resolved
 * from the catalog by exercise_id (not just from local ExercisePicker
 * selections) so AI-generated templates — which reference catalog exercises
 * directly rather than going through the picker — still autoselect a body
 * part whenever the catalog row has one. Exported for direct unit testing
 * (pure function: template + catalog map in, rows out).
 */
export function itemsFromTemplate(template: GymTemplate, exercisesById: Map<string, Exercise>): ItemRow[] {
  return [...template.items]
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      key: nextItemKey(),
      exerciseId: item.exercise_id,
      exerciseName: item.exercise_name,
      bodyPartFilter: (exercisesById.get(item.exercise_id)?.body_part as GymBodyPart | null) ?? null,
      targetSets: item.target_sets != null ? String(item.target_sets) : '',
      targetReps: item.target_reps != null ? String(item.target_reps) : '',
      targetWeightKg: item.target_weight_kg != null ? String(item.target_weight_kg) : '',
      restAfterSeconds: item.rest_after_s != null ? String(item.rest_after_s) : '',
      note: item.note ?? ''
    }))
}

/** Clamp/round to the 0–3600s rest range, or null when blank/invalid. */
function toNullableRestSeconds(s: string): number | null {
  const n = toNullableInt(s)
  if (n == null) return null
  return Math.max(0, Math.min(3600, n))
}

function toNullableInt(s: string): number | null {
  const trimmed = s.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? Math.round(n) : null
}

function toNullableFloat(s: string): number | null {
  const trimmed = s.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function TemplateItemEditor({
  item,
  defaultRestSeconds,
  onChange,
  onRemove
}: {
  item: ItemRow
  defaultRestSeconds: number | null
  onChange: (patch: Partial<ItemRow>) => void
  onRemove: () => void
}): ReactElement {
  const restPlaceholder = defaultRestSeconds != null ? `${formatRest(defaultRestSeconds)} (default)` : 'default'
  return (
    <div className="gym-template-item-row">
      <div className="gym-template-bodypart">
        <Dropdown
          ariaLabel="Filter by body part"
          value={item.bodyPartFilter ?? ''}
          align="left"
          options={BODY_PART_OPTIONS}
          onChange={(v) => onChange({ bodyPartFilter: (v || null) as GymBodyPart | null })}
        />
      </div>
      <ExercisePicker
        value={item.exerciseName}
        bodyPart={item.bodyPartFilter}
        onResolved={(exercise) =>
          onChange({
            exerciseId: exercise.id,
            exerciseName: exercise.name,
            bodyPartFilter: (exercise.body_part as GymBodyPart | null) ?? item.bodyPartFilter
          })
        }
      />
      <input
        className="gym-input gym-template-target-input"
        type="number"
        placeholder="sets"
        value={item.targetSets}
        onChange={(e) => onChange({ targetSets: e.target.value })}
      />
      <input
        className="gym-input gym-template-target-input"
        type="number"
        placeholder="reps"
        value={item.targetReps}
        onChange={(e) => onChange({ targetReps: e.target.value })}
      />
      <input
        className="gym-input gym-template-target-input"
        type="number"
        placeholder="kg"
        value={item.targetWeightKg}
        onChange={(e) => onChange({ targetWeightKg: e.target.value })}
      />
      <input
        className="gym-input gym-template-target-input"
        type="number"
        min={0}
        max={3600}
        placeholder={restPlaceholder}
        aria-label="Rest override (seconds)"
        value={item.restAfterSeconds}
        onChange={(e) => onChange({ restAfterSeconds: e.target.value })}
      />
      <button type="button" className="gym-set-remove" aria-label="Remove exercise" onClick={onRemove}>
        ×
      </button>
    </div>
  )
}

export function TemplateEditorModal({
  template,
  onClose
}: {
  template: GymTemplate | null
  onClose: () => void
}): ReactElement {
  const isEdit = template != null
  const exercisesQuery = useExercises()
  const exercisesById = useMemo(() => {
    const m = new Map<string, Exercise>()
    for (const exercise of exercisesQuery.data ?? []) m.set(exercise.id, exercise)
    return m
  }, [exercisesQuery.data])

  const [name, setName] = useState(template?.name ?? '')
  const [notes, setNotes] = useState(template?.notes ?? '')
  const [items, setItems] = useState<ItemRow[]>(template ? itemsFromTemplate(template, exercisesById) : [])
  const [archived, setArchived] = useState(template?.archived ?? false)
  const [defaultRestSeconds, setDefaultRestSeconds] = useState(
    template?.default_rest_s != null ? String(template.default_rest_s) : ''
  )
  const [error, setError] = useState<string | null>(null)

  const addMutation = useAddGymTemplate()
  const updateMutation = useUpdateGymTemplate()
  const createVersionMutation = useCreateGymTemplateVersion()
  const pending = addMutation.isPending || updateMutation.isPending || createVersionMutation.isPending

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Cold-cache safety net: if the exercise catalog wasn't loaded yet when the
  // rows were first seeded (bodyPartFilter left null for every row), backfill
  // once it arrives. Only touches rows still at null so it never overwrites a
  // body part the user has since picked or explicitly cleared to "Any".
  useEffect(() => {
    if (exercisesById.size === 0) return
    setItems((prev) =>
      prev.map((it) =>
        it.bodyPartFilter == null && it.exerciseId
          ? { ...it, bodyPartFilter: (exercisesById.get(it.exerciseId)?.body_part as GymBodyPart | null) ?? null }
          : it
      )
    )
    // Runs once per catalog load transition, not on every keystroke — items
    // is deliberately excluded to avoid fighting the user's own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercisesById])

  const addItem = (): void => setItems((prev) => [...prev, blankItem()])
  const updateItem = (key: string, patch: Partial<ItemRow>): void =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)))
  const removeItem = (key: string): void => setItems((prev) => prev.filter((it) => it.key !== key))

  /** Validates the form and builds the shared NewGymTemplate payload, or returns null on error. */
  const buildPayload = (): { name: string; notes: string | null; default_rest_s: number | null; items: NewGymTemplateItem[] } | null => {
    setError(null)
    if (!name.trim()) {
      setError('Give the template a name.')
      return null
    }
    const incomplete = items.some((it) => !it.exerciseId)
    if (incomplete) {
      setError('Finish or remove the exercise row without a name.')
      return null
    }
    const newItems: NewGymTemplateItem[] = items.map((it) => ({
      exercise_id: it.exerciseId as string,
      target_sets: toNullableInt(it.targetSets),
      target_reps: toNullableInt(it.targetReps),
      target_weight_kg: toNullableFloat(it.targetWeightKg),
      rest_after_s: toNullableRestSeconds(it.restAfterSeconds),
      note: it.note.trim() || null
    }))
    return {
      name: name.trim(),
      notes: notes.trim() || null,
      default_rest_s: toNullableRestSeconds(defaultRestSeconds),
      items: newItems
    }
  }

  const handleSave = (): void => {
    const payload = buildPayload()
    if (!payload) return

    if (isEdit && template) {
      updateMutation.mutate({
        id: template.id,
        patch: { ...payload, archived }
      })
      onClose()
      return
    }

    addMutation.mutate(payload)
    onClose()
  }

  const handleSaveAsNewVersion = (): void => {
    if (!isEdit || !template) return
    const payload = buildPayload()
    if (!payload) return
    createVersionMutation.mutate({ baseTemplateId: template.id, template: payload })
    onClose()
  }

  return (
    <div className="gym-modal-overlay" onClick={onClose}>
      <div
        className="gym-modal gym-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit template' : 'New template'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gym-modal-head">
          <h3 className="gym-modal-title">{isEdit ? 'Edit template' : 'New template'}</h3>
          <button type="button" className="gym-modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="gym-modal-body">
          <label className="gym-field">
            <span className="gym-field-label">Name</span>
            <input
              className="gym-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="gym-field">
            <span className="gym-field-label">Notes</span>
            <textarea
              className="gym-textarea"
              rows={2}
              placeholder="Optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          <label className="gym-field gym-template-rest-default-field">
            <span className="gym-field-label">Default rest between sets (seconds)</span>
            <input
              className="gym-input"
              type="number"
              min={0}
              max={3600}
              placeholder="none"
              value={defaultRestSeconds}
              onChange={(e) => setDefaultRestSeconds(e.target.value)}
            />
          </label>

          <h4 className="gym-modal-section-title">Exercises</h4>
          <div className="gym-template-items">
            {items.map((item) => (
              <TemplateItemEditor
                key={item.key}
                item={item}
                defaultRestSeconds={toNullableRestSeconds(defaultRestSeconds)}
                onChange={(patch) => updateItem(item.key, patch)}
                onRemove={() => removeItem(item.key)}
              />
            ))}
          </div>

          <button type="button" className="gym-quiet-action" onClick={addItem}>
            + exercise
          </button>

          {isEdit && (
            <label className="gym-check gym-archive-toggle">
              <input
                className="gym-check-input"
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              <span className="gym-check-mark" aria-hidden="true" />
              Archived
            </label>
          )}

          {error && <p className="gym-error">{error}</p>}

          <div className="gym-modal-actions">
            <button type="button" className="gym-btn gym-btn--primary" disabled={pending} onClick={handleSave}>
              {updateMutation.isPending || addMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            {isEdit && template && (
              <button
                type="button"
                className="gym-btn"
                disabled={pending}
                onClick={handleSaveAsNewVersion}
              >
                {createVersionMutation.isPending
                  ? 'Saving…'
                  : `Save as new version (v${template.version + 1})`}
              </button>
            )}
            <button type="button" className="gym-btn" onClick={onClose} disabled={pending}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
