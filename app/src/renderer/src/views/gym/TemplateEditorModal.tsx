// Template create/edit modal: name, notes, an ordered item list (exercise +
// optional targets), and an archive toggle for existing templates.
import { useEffect, useState, type ReactElement } from 'react'
import { GYM_BODY_PARTS, type GymBodyPart, type GymTemplate, type NewGymTemplateItem } from '@shared/types'
import { useAddGymTemplate, useUpdateGymTemplate } from '../../hooks/useGymData'
import { ExercisePicker } from './ExercisePicker'
import '../GymView.css'

interface ItemRow {
  key: string
  exerciseId: string | null
  exerciseName: string
  // UI-only picker filter, autofilled back from a picked exercise's body_part.
  bodyPartFilter: GymBodyPart | null
  targetSets: string
  targetReps: string
  targetWeightKg: string
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
    note: ''
  }
}

function itemsFromTemplate(template: GymTemplate): ItemRow[] {
  return [...template.items]
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      key: nextItemKey(),
      exerciseId: item.exercise_id,
      exerciseName: item.exercise_name,
      bodyPartFilter: null,
      targetSets: item.target_sets != null ? String(item.target_sets) : '',
      targetReps: item.target_reps != null ? String(item.target_reps) : '',
      targetWeightKg: item.target_weight_kg != null ? String(item.target_weight_kg) : '',
      note: item.note ?? ''
    }))
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
  onChange,
  onRemove
}: {
  item: ItemRow
  onChange: (patch: Partial<ItemRow>) => void
  onRemove: () => void
}): ReactElement {
  return (
    <div className="gym-template-item-row">
      <select
        className="gym-input gym-bodypart-select"
        aria-label="Filter by body part"
        value={item.bodyPartFilter ?? ''}
        onChange={(e) => onChange({ bodyPartFilter: (e.target.value || null) as GymBodyPart | null })}
      >
        <option value="">any</option>
        {GYM_BODY_PARTS.map((part) => (
          <option key={part} value={part}>
            {part}
          </option>
        ))}
      </select>
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
  const [name, setName] = useState(template?.name ?? '')
  const [notes, setNotes] = useState(template?.notes ?? '')
  const [items, setItems] = useState<ItemRow[]>(template ? itemsFromTemplate(template) : [])
  const [archived, setArchived] = useState(template?.archived ?? false)
  const [error, setError] = useState<string | null>(null)

  const addMutation = useAddGymTemplate()
  const updateMutation = useUpdateGymTemplate()
  const pending = addMutation.isPending || updateMutation.isPending

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addItem = (): void => setItems((prev) => [...prev, blankItem()])
  const updateItem = (key: string, patch: Partial<ItemRow>): void =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)))
  const removeItem = (key: string): void => setItems((prev) => prev.filter((it) => it.key !== key))

  const handleSave = (): void => {
    setError(null)
    if (!name.trim()) {
      setError('Give the template a name.')
      return
    }
    const incomplete = items.some((it) => !it.exerciseId)
    if (incomplete) {
      setError('Finish or remove the exercise row without a name.')
      return
    }
    const newItems: NewGymTemplateItem[] = items.map((it) => ({
      exercise_id: it.exerciseId as string,
      target_sets: toNullableInt(it.targetSets),
      target_reps: toNullableInt(it.targetReps),
      target_weight_kg: toNullableFloat(it.targetWeightKg),
      note: it.note.trim() || null
    }))

    if (isEdit && template) {
      updateMutation.mutate(
        {
          id: template.id,
          patch: { name: name.trim(), notes: notes.trim() || null, archived, items: newItems }
        },
        {
          onSuccess: () => onClose(),
          onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.')
        }
      )
      return
    }

    addMutation.mutate(
      { name: name.trim(), notes: notes.trim() || null, items: newItems },
      {
        onSuccess: () => onClose(),
        onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.')
      }
    )
  }

  return (
    <div className="gym-modal-overlay" onClick={onClose}>
      <div
        className="gym-modal"
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

          <div className="gym-template-items">
            {items.map((item) => (
              <TemplateItemEditor
                key={item.key}
                item={item}
                onChange={(patch) => updateItem(item.key, patch)}
                onRemove={() => removeItem(item.key)}
              />
            ))}
          </div>

          <button type="button" className="gym-quiet-action" onClick={addItem}>
            + exercise
          </button>

          {isEdit && (
            <label className="gym-archive-toggle">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              Archived
            </label>
          )}

          {error && <p className="gym-error">{error}</p>}

          <div className="gym-modal-actions">
            <button type="button" className="gym-btn gym-btn--primary" disabled={pending} onClick={handleSave}>
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="gym-btn" onClick={onClose} disabled={pending}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
