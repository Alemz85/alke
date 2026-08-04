// Template create/edit modal: name, notes, an ordered item list (exercise +
// optional targets), and an archive toggle for existing templates.
import { useEffect, useMemo, useState, type DragEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react'
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

/**
 * Moves the item with `key` one slot up or down. Clamped at both ends (a no-op
 * past either edge returns the SAME array reference, so a repeat click on a
 * boundary row skips the re-render). Mirrors SessionEditorModal's `moveBlock`
 * so the two gym editors reorder by identical rules.
 */
export function moveTemplateItem(items: ItemRow[], key: string, direction: 'up' | 'down'): ItemRow[] {
  const index = items.findIndex((it) => it.key === key)
  const nextIndex = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return items
  const next = [...items]
  ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
  return next
}

/**
 * Drag-and-drop landing rule: the dragged row TAKES the target row's slot, and
 * everything between them shifts by one. Deliberately not useCardOrder's
 * "insert before the target" rule — that one is direction-blind, so in a single
 * COLUMN dragging a row onto the row directly below it is a visible no-op
 * (remove, then re-insert in front of the same neighbour). Taking the target's
 * index reads correctly in both directions. Dropping a row on itself, or either
 * key being absent, is a no-op returning the same array reference.
 */
export function moveTemplateItemTo(items: ItemRow[], key: string, targetKey: string): ItemRow[] {
  if (key === targetKey) return items
  const from = items.findIndex((it) => it.key === key)
  const to = items.findIndex((it) => it.key === targetKey)
  if (from < 0 || to < 0) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
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

/**
 * Reorder affordance for one editor row: a drag grip plus an up/down keyboard
 * fallback, so the list is reorderable by pointer AND by keyboard. Same control
 * set as the templates grid's handle, but rendered INLINE (the editor row is a
 * flex line, not an absolutely-positioned card) and always visible — a form row
 * has no hover-reveal affordance to lean on.
 */
function ItemReorderHandle({
  dragging,
  onDragStart,
  onDragEnd,
  onMoveUp,
  onMoveDown,
  disableUp,
  disableDown
}: {
  dragging: boolean
  onDragStart: (e: DragEvent<HTMLSpanElement>) => void
  onDragEnd: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  disableUp: boolean
  disableDown: boolean
}): ReactElement {
  return (
    <span className={`reorder-handle reorder-handle--inline${dragging ? ' reorder-handle--dragging' : ''}`}>
      <span
        className="reorder-grip"
        draggable
        role="button"
        tabIndex={-1}
        aria-hidden="true"
        title="Drag to reorder"
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <GripVertical size={14} strokeWidth={1.75} />
      </span>
      <button
        type="button"
        className="reorder-step"
        aria-label="Move exercise up"
        disabled={disableUp}
        onClick={onMoveUp}
      >
        <ChevronUp size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="reorder-step"
        aria-label="Move exercise down"
        disabled={disableDown}
        onClick={onMoveDown}
      >
        <ChevronDown size={13} strokeWidth={2} />
      </button>
    </span>
  )
}

function TemplateItemEditor({
  item,
  defaultRestSeconds,
  reorder,
  onChange,
  onRemove
}: {
  item: ItemRow
  defaultRestSeconds: number | null
  reorder: {
    dragging: boolean
    isFirst: boolean
    isLast: boolean
    onDragStart: (e: DragEvent<HTMLSpanElement>) => void
    onDragEnd: () => void
    onDragOver: (e: DragEvent<HTMLDivElement>) => void
    onDrop: (e: DragEvent<HTMLDivElement>) => void
    onMoveUp: () => void
    onMoveDown: () => void
  }
  onChange: (patch: Partial<ItemRow>) => void
  onRemove: () => void
}): ReactElement {
  const restPlaceholder = defaultRestSeconds != null ? `${formatRest(defaultRestSeconds)} (default)` : 'default'
  return (
    <div
      className={`gym-template-item-row${reorder.dragging ? ' gym-template-item-row--dragging' : ''}`}
      onDragOver={reorder.onDragOver}
      onDrop={reorder.onDrop}
    >
      <ItemReorderHandle
        dragging={reorder.dragging}
        onDragStart={reorder.onDragStart}
        onDragEnd={reorder.onDragEnd}
        onMoveUp={reorder.onMoveUp}
        onMoveDown={reorder.onMoveDown}
        disableUp={reorder.isFirst}
        disableDown={reorder.isLast}
      />
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
  // Key of the row currently being dragged, or null. Local to the open modal —
  // item order is the array order and is only persisted (as `position`) on save.
  const [draggedKey, setDraggedKey] = useState<string | null>(null)

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
  }, [exercisesById])

  const addItem = (): void => setItems((prev) => [...prev, blankItem()])
  const updateItem = (key: string, patch: Partial<ItemRow>): void =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)))
  const removeItem = (key: string): void => setItems((prev) => prev.filter((it) => it.key !== key))
  const moveItem = (key: string, direction: 'up' | 'down'): void =>
    setItems((prev) => moveTemplateItem(prev, key, direction))
  const dropItemOn = (key: string, targetKey: string): void =>
    setItems((prev) => moveTemplateItemTo(prev, key, targetKey))

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
    // Array order IS the saved order: the main process stamps `position` from
    // the array index (db.ts insertTemplateItems), so a reorder here persists
    // through both Save and Save-as-new-version with no extra plumbing.
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
            {items.map((item, index) => (
              <TemplateItemEditor
                key={item.key}
                item={item}
                defaultRestSeconds={toNullableRestSeconds(defaultRestSeconds)}
                reorder={{
                  dragging: draggedKey === item.key,
                  isFirst: index === 0,
                  isLast: index === items.length - 1,
                  onDragStart: (e) => {
                    setDraggedKey(item.key)
                    e.dataTransfer.effectAllowed = 'move'
                  },
                  onDragEnd: () => setDraggedKey(null),
                  onDragOver: (e) => {
                    if (draggedKey == null || draggedKey === item.key) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  },
                  onDrop: (e) => {
                    e.preventDefault()
                    if (draggedKey == null || draggedKey === item.key) return
                    dropItemOn(draggedKey, item.key)
                    setDraggedKey(null)
                  },
                  onMoveUp: () => moveItem(item.key, 'up'),
                  onMoveDown: () => moveItem(item.key, 'down')
                }}
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
