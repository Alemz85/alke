import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { CheckCircle2, Pencil, Play, Timer, Trash2 } from 'lucide-react'
import type { GymTemplate } from '@shared/types'
import { Dropdown } from '../../components/Dropdown'
import {
  useCompleteGymTemplateRun,
  useDeleteGymTemplate,
  useExercises,
  useGymTemplateVersions,
  useStartGymTemplateRun,
  useUpdateGymTemplate
} from '../../hooks/useGymData'
import { displayBodyPart, formatRest } from '../../lib/gymLog'
import { estimateTemplateDurationSeconds, formatEstimatedDuration } from './gymFormat'
import '../GymView.css'

type Item = GymTemplate['items'][number]

function fmtStarted(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtRunDate(dateIso: string): string {
  // dateIso is YYYY-MM-DD; parse as local to avoid off-by-one from UTC parsing.
  const [y, m, d] = dateIso.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function targetLine(item: Item): string {
  const hasSR = item.target_sets != null || item.target_reps != null
  const sr = hasSR ? `${item.target_sets ?? '—'} × ${item.target_reps ?? '—'}` : null
  const w = item.target_weight_kg != null ? `${item.target_weight_kg} kg` : null
  return [sr, w].filter(Boolean).join(' · ') || 'no target'
}

/** Effective rest for a template item: its own override, else the template default. */
function effectiveRest(item: Item, template: GymTemplate): number | null {
  return item.rest_after_s ?? template.default_rest_s ?? null
}

/**
 * Permanently deletes a template. Two-step inline confirm (never browser
 * confirm()) — mirrors SessionEditorModal's log-delete zone: first click
 * arms, auto-disarms after 4s, second click commits. Lives in a
 * hairline-separated modal footer, away from Edit/lifecycle so it never sits
 * next to routine actions. Closes the modal on success since the template it
 * was viewing is gone.
 */
function TemplateDeleteControl({
  templateId,
  onDeleted
}: {
  templateId: string
  onDeleted: () => void
}): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deleteMutation = useDeleteGymTemplate()

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const handleClick = (): void => {
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 4000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    deleteMutation.mutate(templateId, { onSuccess: onDeleted })
  }

  return (
    <div className="gym-delete-zone">
      {confirming ? (
        <>
          <span className="gym-delete-confirm-label">Delete this template?</span>
          <button
            type="button"
            className="gym-btn gym-btn--danger"
            disabled={deleteMutation.isPending}
            onClick={handleClick}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Confirm delete'}
          </button>
          <button
            type="button"
            className="gym-btn"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (confirmTimer.current) clearTimeout(confirmTimer.current)
              setConfirming(false)
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="gym-btn gym-btn--danger" onClick={handleClick}>
          <Trash2 size={14} strokeWidth={1.6} aria-hidden="true" />
          Delete template
        </button>
      )}
      {deleteMutation.isError && <span className="gym-delete-confirm-label">Could not delete</span>}
    </div>
  )
}

/**
 * Read-only view of a saved template — the default action when a card is
 * clicked. Shows metadata (started, times done) and the exercise list; an Edit
 * button routes to the editor.
 */
export function TemplateViewModal({
  template,
  usageCount,
  onEdit,
  onClose
}: {
  template: GymTemplate
  usageCount: number
  onEdit: () => void
  onClose: () => void
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const versionsQuery = useGymTemplateVersions(template.family_id)
  const versions = versionsQuery.data ?? []
  const hasMultipleVersions = versions.length > 1

  const exercisesQuery = useExercises()
  const bodyPartByExerciseId = useMemo(() => {
    const m = new Map<string, string>()
    for (const exercise of exercisesQuery.data ?? []) {
      if (exercise.body_part) m.set(exercise.id, exercise.body_part)
    }
    return m
  }, [exercisesQuery.data])

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  useEffect(() => {
    // Reset the selection back to the current version whenever the viewed
    // template changes (e.g. opening a different card).
    setSelectedVersionId(null)
  }, [template.id])

  const shown = useMemo(() => {
    if (selectedVersionId == null) return template
    return versions.find((v) => v.id === selectedVersionId) ?? template
  }, [selectedVersionId, versions, template])

  const startRunMutation = useStartGymTemplateRun()
  const completeRunMutation = useCompleteGymTemplateRun()
  const archiveMutation = useUpdateGymTemplate()
  const lifecyclePending =
    startRunMutation.isPending || completeRunMutation.isPending || archiveMutation.isPending

  const items = [...shown.items].sort((a, b) => a.position - b.position)
  const runs = [...shown.runs].sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
  const isActive = runs.length > 0 && runs[0].ended_at === null

  // Marking a template complete both closes its active run and archives it —
  // it moves out of the active Templates grid into the Archive section below
  // Recovery plans, rather than staying visible with no further action.
  const handleMarkComplete = (): void => {
    completeRunMutation.mutate(shown.id, {
      onSuccess: () => archiveMutation.mutate({ id: shown.id, patch: { archived: true } })
    })
  }

  const versionOptions = [...versions]
    .sort((a, b) => a.version - b.version)
    .map((v) => ({
      value: v.id,
      label: `v${v.version}${v.is_current ? ' (current)' : ''}`
    }))

  return (
    <div className="gym-modal-overlay" onClick={onClose}>
      <div
        className="gym-modal gym-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={`Template ${template.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gym-modal-head">
          <h3 className="gym-modal-title">{template.name}</h3>
          <div className="gym-tv-head-actions">
            {hasMultipleVersions && (
              <Dropdown
                ariaLabel="Template version"
                value={selectedVersionId ?? template.id}
                options={versionOptions}
                onChange={(id) => setSelectedVersionId(id === template.id ? null : id)}
                align="left"
              />
            )}
            {!shown.archived &&
              (isActive ? (
                <button
                  type="button"
                  className="gym-btn gym-tv-lifecycle-btn"
                  disabled={lifecyclePending}
                  onClick={handleMarkComplete}
                >
                  <CheckCircle2 size={14} strokeWidth={2} />
                  {completeRunMutation.isPending || archiveMutation.isPending
                    ? 'Completing…'
                    : 'Mark complete'}
                </button>
              ) : (
                <button
                  type="button"
                  className="gym-btn gym-tv-lifecycle-btn"
                  disabled={lifecyclePending}
                  onClick={() => startRunMutation.mutate(shown.id)}
                >
                  <Play size={14} strokeWidth={2} />
                  {startRunMutation.isPending ? 'Starting…' : runs.length > 0 ? 'Resurrect' : 'Start'}
                </button>
              ))}
            <button type="button" className="gym-btn gym-btn--primary gym-tv-edit" onClick={onEdit}>
              <Pencil size={14} strokeWidth={2} />
              Edit
            </button>
            <button type="button" className="gym-modal-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        <div className="gym-modal-body">
          <div className="gym-tv-meta">
            <span className="gym-tv-chip">Started {fmtStarted(shown.created_at)}</span>
            <span className="gym-tv-chip">
              Done {usageCount}
              {'×'}
            </span>
            <span className="gym-tv-chip">
              {items.length} exercise{items.length === 1 ? '' : 's'}
            </span>
            {shown.default_rest_s != null && (
              <span className="gym-tv-chip gym-tv-chip--rest">
                <Timer size={12} strokeWidth={2} aria-hidden="true" />
                Rest {formatRest(shown.default_rest_s)}
              </span>
            )}
            {items.length > 0 && (
              <span className="gym-tv-chip" title="Rough estimate based on sets, reps, and rest">
                {formatEstimatedDuration(estimateTemplateDurationSeconds(shown))}
              </span>
            )}
          </div>

          {shown.notes && <p className="gym-tv-notes">{shown.notes}</p>}

          <h4 className="gym-modal-section-title">Exercises</h4>
          {items.length === 0 ? (
            <p className="gym-quicklog-hint">No exercises in this template yet.</p>
          ) : (
            <ol className="gym-tv-exercises">
              {items.map((item, i) => {
                const rest = effectiveRest(item, shown)
                const isOverride = item.rest_after_s != null
                const bodyPart = bodyPartByExerciseId.get(item.exercise_id)
                return (
                  <li key={i} className="gym-tv-exercise">
                    <span className="gym-tv-exercise-index tabular-nums">{i + 1}</span>
                    <span className="gym-tv-exercise-main">
                      <span className="gym-tv-exercise-name-row">
                        <span className="gym-tv-exercise-name">{item.exercise_name}</span>
                        {bodyPart && (
                          <span className="gym-tv-exercise-bodypart">{displayBodyPart(bodyPart)}</span>
                        )}
                      </span>
                      {item.note && <span className="gym-tv-exercise-note">{item.note}</span>}
                      {isOverride && rest != null && (
                        <span className="gym-tv-exercise-rest">
                          <Timer size={11} strokeWidth={2} aria-hidden="true" />
                          Rest {formatRest(rest)}
                        </span>
                      )}
                    </span>
                    <span className="gym-tv-exercise-target tabular-nums">{targetLine(item)}</span>
                  </li>
                )
              })}
            </ol>
          )}

          <h4 className="gym-modal-section-title">Run history</h4>
          {runs.length === 0 ? (
            <p className="gym-quicklog-hint">Never started.</p>
          ) : (
            <ul className="gym-tv-runs">
              {runs.map((run) => (
                <li key={run.id} className="gym-tv-run">
                  <span className="gym-tv-run-range">
                    {fmtRunDate(run.started_at)}
                    {' → '}
                    {run.ended_at ? fmtRunDate(run.ended_at) : 'active'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="gym-tv-footer">
          <TemplateDeleteControl templateId={shown.id} onDeleted={onClose} />
        </div>
      </div>
    </div>
  )
}
