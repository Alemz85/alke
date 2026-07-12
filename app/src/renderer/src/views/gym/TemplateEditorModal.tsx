// Template create/edit modal: name, notes, an ordered item list (exercise +
// optional targets), and an archive toggle for existing templates.
import { useEffect, useState, type ReactElement } from 'react'
import type { GymTemplate, NewGymTemplateItem } from '@shared/types'
import { useAddExercise, useAddGymTemplate, useExercises, useUpdateGymTemplate } from '../../hooks/useGymData'
import '../GymView.css'

interface ItemRow {
  key: string
  exerciseId: string | null
  exerciseName: string
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

function ItemExercisePicker({
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
    </>
  )
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
      <ItemExercisePicker
        value={item.exerciseName}
        onResolved={(id, name) => onChange({ exerciseId: id, exerciseName: name })}
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
