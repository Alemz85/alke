// Catalog-aware exercise autocomplete, shared by the session and template
// editors. Ranks name + alias matches (incl. non-English gym terms) via
// lib/exerciseSearch.ts, capped at 5 "most likely" suggestions; an optional
// body-part filter narrows the pool (and an empty query then shows that
// part's top exercises). Unmatched text can be created on the spot.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Exercise, GymBodyPart } from '@shared/types'
import { useAddExercise, useExercises } from '../../hooks/useGymData'
import { rankExercises, type ExerciseUsageEntry } from '../../lib/exerciseSearch'

export function ExercisePicker({
  value,
  bodyPart,
  usage,
  onResolved
}: {
  value: string
  bodyPart?: GymBodyPart | null
  usage?: Map<string, ExerciseUsageEntry>
  onResolved: (exercise: Exercise) => void
}): ReactElement {
  const exercisesQuery = useExercises()
  const addExercise = useAddExercise()
  const exercises = useMemo(() => exercisesQuery.data ?? [], [exercisesQuery.data])

  const [text, setText] = useState(value)
  // External value changes (template prefill, block replacement) reset the input.
  useEffect(() => setText(value), [value])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  // Suppress the blur-close while a mousedown on a dropdown row is resolving.
  const selectingRef = useRef(false)

  const results = useMemo(
    () => (open ? rankExercises(text, exercises, { bodyPart: bodyPart ?? null, usage }) : []),
    [open, text, exercises, bodyPart, usage]
  )

  const trimmed = text.trim()
  const normalizedInput = trimmed.toLowerCase()
  const exactMatch = exercises.find(
    (e) =>
      e.name.toLowerCase() === normalizedInput ||
      e.aliases.some((a) => a === normalizedInput)
  )
  const showCreateRow = open && trimmed.length > 0 && !exactMatch && !addExercise.isPending
  const showCreatingRow = open && trimmed.length > 0 && addExercise.isPending
  const rowCount = results.length + (showCreateRow || showCreatingRow ? 1 : 0)

  const select = (exercise: Exercise): void => {
    setText(exercise.name)
    setOpen(false)
    onResolved(exercise)
  }

  const createAndSelect = (): void => {
    if (!trimmed) return
    addExercise.mutate(
      { name: trimmed, bodyPart: bodyPart ?? null },
      { onSuccess: (created) => select(created) }
    )
  }

  const activate = (index: number): void => {
    if (index < results.length) {
      select(results[index])
    } else if (showCreateRow) {
      createAndSelect()
    }
  }

  const commitFallback = (): void => {
    // Enter/blur without touching the dropdown: exact name/alias match wins,
    // otherwise create the typed text (the round-1 create-on-type behavior).
    if (exactMatch) select(exactMatch)
    else if (trimmed) createAndSelect()
  }

  return (
    <div className="gym-picker">
      <input
        className="gym-input gym-exercise-input"
        type="text"
        placeholder="Exercise"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          setHighlight(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          if (selectingRef.current) return
          setOpen(false)
          if (trimmed && trimmed !== value) commitFallback()
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setHighlight((h) => Math.min(h + 1, Math.max(rowCount - 1, 0)))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight((h) => Math.max(h - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (open && rowCount > 0) activate(Math.min(highlight, rowCount - 1))
            else commitFallback()
          } else if (e.key === 'Escape') {
            if (open) {
              // Swallow it: Escape with the dropdown up dismisses the dropdown,
              // not the whole modal (which also listens on window keydown).
              e.stopPropagation()
              setOpen(false)
            }
          }
        }}
      />
      {open && rowCount > 0 && (
        <div className="gym-picker-dropdown" role="listbox">
          {results.map((exercise, i) => (
            <button
              key={exercise.id}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className={
                i === highlight ? 'gym-picker-row gym-picker-row--active' : 'gym-picker-row'
              }
              onMouseDown={() => {
                selectingRef.current = true
              }}
              onMouseUp={() => {
                selectingRef.current = false
              }}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => select(exercise)}
            >
              <span className="gym-picker-name">{exercise.name}</span>
              <span className="gym-picker-meta">
                {[exercise.body_part, exercise.equipment].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
          {showCreateRow && (
            <button
              type="button"
              role="option"
              aria-selected={highlight === results.length}
              className={
                highlight === results.length
                  ? 'gym-picker-row gym-picker-row--create gym-picker-row--active'
                  : 'gym-picker-row gym-picker-row--create'
              }
              onMouseDown={() => {
                selectingRef.current = true
              }}
              onMouseUp={() => {
                selectingRef.current = false
              }}
              onMouseEnter={() => setHighlight(results.length)}
              onClick={createAndSelect}
            >
              <span className="gym-picker-name">Create “{trimmed}”…</span>
            </button>
          )}
          {showCreatingRow && (
            <div
              role="option"
              aria-selected="false"
              aria-disabled="true"
              className="gym-picker-row gym-picker-row--create"
            >
              <span className="gym-picker-name">Creating “{trimmed}”…</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
