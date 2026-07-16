import { useMemo, useState, type DragEvent, type ReactElement } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, GripVertical, Play, Timer } from 'lucide-react'
import type { GymTemplate } from '@shared/types'
import { ButtonSoft } from '../../components/ButtonSoft'
import { EmptyState } from '../../components/EmptyState'
import {
  useCompleteGymTemplateRun,
  useDeleteGymTemplate,
  useStartGymTemplateRun,
  useUpdateGymTemplate
} from '../../hooks/useGymData'
import { useCardOrder } from '../../hooks/useCardOrder'
import { formatRest } from '../../lib/gymLog'
import { recoveryOverviewPreview, type RecoveryLogTemplate } from '../../lib/recoveryLogTemplates'
import { RecoveryTemplateViewModal } from './RecoveryTemplateViewModal'

/**
 * An injury only earns a card here once its recovery plan has actually been
 * started (Injuries tab "Set plan start" / plan_started_at) — an injury with
 * no plan yet (the common case right after logging an injury) has an empty
 * bundle but was still rendering a card before this fix. A prose-only plan
 * with no linked exercises yet is still a real, active plan and keeps
 * showing (its card just can't offer "Use in log" until exercises resolve —
 * the same gate the session-editor template picker applies there).
 */
function hasActivePlan(template: RecoveryLogTemplate): boolean {
  return template.planStartedAt != null
}

const PREVIEW_LIMIT = 4
const RECOVERY_OVERVIEW_PREVIEW_CHARS = 180

function fmtLifecycleDate(dateIso: string): string {
  // dateIso is YYYY-MM-DD; parse as local to avoid off-by-one from UTC parsing.
  const [y, m, d] = dateIso.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Shared delete zone (confirm/cancel dance) for both the active and archived cards. */
function DeleteAction({ templateId }: { templateId: string }): ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteMutation = useDeleteGymTemplate()

  if (!confirmDelete) {
    return (
      <button
        type="button"
        className="gym-quiet-action gym-quiet-action--danger"
        onClick={(event) => {
          event.stopPropagation()
          setConfirmDelete(true)
        }}
      >
        Delete
      </button>
    )
  }
  return (
    <span className="gym-tpl-card-confirm" onClick={(event) => event.stopPropagation()}>
      <span className="gym-delete-confirm-label">Delete?</span>
      <button
        type="button"
        className="gym-quiet-action gym-quiet-action--danger"
        disabled={deleteMutation.isPending}
        onClick={(event) => {
          event.stopPropagation()
          deleteMutation.mutate(templateId)
        }}
      >
        {deleteMutation.isPending ? 'Deleting…' : 'Confirm'}
      </button>
      <button
        type="button"
        className="gym-quiet-action"
        disabled={deleteMutation.isPending}
        onClick={(event) => {
          event.stopPropagation()
          setConfirmDelete(false)
        }}
      >
        Cancel
      </button>
    </span>
  )
}

// ── reorder handle (drag + keyboard-accessible up/down fallback) ──────────
// Same mechanism as InjuriesView's active-card list: an HTML5 drag source
// plus up/down buttons so reordering never depends on drag-and-drop actually
// landing (trackpad, screen reader, keyboard-only use). All controls stop
// click/drag propagation so they never trigger the card's own onView.
function ReorderHandle({
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
    <span className={`reorder-handle${dragging ? ' reorder-handle--dragging' : ''}`}>
      <span
        className="reorder-grip"
        draggable
        role="button"
        tabIndex={-1}
        aria-hidden="true"
        title="Drag to reorder"
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={14} strokeWidth={1.75} />
      </span>
      <button
        type="button"
        className="reorder-step"
        aria-label="Move up"
        disabled={disableUp}
        onClick={(e) => {
          e.stopPropagation()
          onMoveUp()
        }}
      >
        <ChevronUp size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="reorder-step"
        aria-label="Move down"
        disabled={disableDown}
        onClick={(e) => {
          e.stopPropagation()
          onMoveDown()
        }}
      >
        <ChevronDown size={13} strokeWidth={2} />
      </button>
    </span>
  )
}

function TemplateCard({
  template,
  usageCount,
  onView,
  reorder
}: {
  template: GymTemplate
  usageCount: number
  onView: () => void
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
}): ReactElement {
  const items = [...template.items].sort((a, b) => a.position - b.position)
  const preview = items.slice(0, PREVIEW_LIMIT)
  const startRunMutation = useStartGymTemplateRun()
  const completeRunMutation = useCompleteGymTemplateRun()
  const archiveMutation = useUpdateGymTemplate()

  const latestRun = template.runs[0]
  const isActive = latestRun != null && latestRun.ended_at === null
  const lifecyclePending =
    startRunMutation.isPending || completeRunMutation.isPending || archiveMutation.isPending

  // Marking complete both closes the run and archives the template — it
  // moves out of this grid into the Archive section below Recovery plans.
  const handleMarkComplete = (): void => {
    completeRunMutation.mutate(template.id, {
      onSuccess: () => archiveMutation.mutate({ id: template.id, patch: { archived: true } })
    })
  }

  return (
    <div
      className={`gym-tpl-card${reorder.dragging ? ' gym-tpl-card--dragging' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`View ${template.name} template`}
      onClick={onView}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onView()
        }
      }}
      onDragOver={reorder.onDragOver}
      onDrop={reorder.onDrop}
    >
      <ReorderHandle
        dragging={reorder.dragging}
        onDragStart={reorder.onDragStart}
        onDragEnd={reorder.onDragEnd}
        onMoveUp={reorder.onMoveUp}
        onMoveDown={reorder.onMoveDown}
        disableUp={reorder.isFirst}
        disableDown={reorder.isLast}
      />
      <div className="gym-tpl-card-click">
        <span className="gym-tpl-card-name-row">
          <span className="gym-tpl-card-name">{template.name}</span>
          {template.version > 1 && (
            <span className="gym-tpl-card-version">v{template.version}</span>
          )}
        </span>
        {isActive ? (
          <span className="gym-tpl-card-lifecycle gym-tpl-card-lifecycle--active">
            Active since {fmtLifecycleDate(latestRun.started_at)}
          </span>
        ) : latestRun?.ended_at ? (
          <span className="gym-tpl-card-lifecycle">Last done {fmtLifecycleDate(latestRun.ended_at)}</span>
        ) : null}
        {items.length === 0 ? (
          <span className="gym-tpl-card-empty">No exercises yet</span>
        ) : (
          <ul className="gym-tpl-card-items">
            {preview.map((it, i) => (
              <li key={i} className="gym-tpl-card-item">
                <span className="gym-tpl-card-item-name">{it.exercise_name}</span>
                <span className="gym-tpl-card-item-target tabular-nums">
                  {it.target_sets ?? '—'}×{it.target_reps ?? '—'}
                </span>
              </li>
            ))}
            {items.length > PREVIEW_LIMIT && (
              <li className="gym-tpl-card-more">+{items.length - PREVIEW_LIMIT} more</li>
            )}
          </ul>
        )}
      </div>
      <div className="gym-tpl-card-foot">
        <span className="gym-tpl-card-meta tabular-nums">Done {usageCount}×</span>
        {template.default_rest_s != null && (
          <span className="gym-tpl-card-rest tabular-nums">
            <Timer size={12} strokeWidth={2} aria-hidden="true" />
            {formatRest(template.default_rest_s)}
          </span>
        )}
        <span className="gym-tpl-card-actions">
          {isActive ? (
            <button
              type="button"
              className="gym-btn gym-tpl-card-lifecycle-btn"
              disabled={lifecyclePending}
              onClick={(event) => {
                event.stopPropagation()
                handleMarkComplete()
              }}
            >
              <CheckCircle2 size={13} strokeWidth={2} />
              {completeRunMutation.isPending || archiveMutation.isPending
                ? 'Completing…'
                : 'Mark complete'}
            </button>
          ) : (
            <button
              type="button"
              className="gym-btn gym-tpl-card-lifecycle-btn"
              disabled={lifecyclePending}
              onClick={(event) => {
                event.stopPropagation()
                startRunMutation.mutate(template.id)
              }}
            >
              <Play size={13} strokeWidth={2} />
              {startRunMutation.isPending ? 'Starting…' : latestRun ? 'Resurrect' : 'Start'}
            </button>
          )}
          <DeleteAction templateId={template.id} />
        </span>
      </div>
    </div>
  )
}

/** Archived template card: no lifecycle actions (those live on the active
 * card / view modal) — just enough to bring it back or remove it for good. */
function ArchivedTemplateCard({
  template,
  usageCount,
  onView,
  onUnarchive
}: {
  template: GymTemplate
  usageCount: number
  onView: () => void
  onUnarchive: () => void
}): ReactElement {
  const items = [...template.items].sort((a, b) => a.position - b.position)
  const preview = items.slice(0, PREVIEW_LIMIT)

  return (
    <div
      className="gym-tpl-card gym-tpl-card--archived"
      role="button"
      tabIndex={0}
      aria-label={`View ${template.name} template`}
      onClick={onView}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onView()
        }
      }}
    >
      <div className="gym-tpl-card-click">
        <span className="gym-tpl-card-name-row">
          <span className="gym-tpl-card-name">{template.name}</span>
          {template.version > 1 && (
            <span className="gym-tpl-card-version">v{template.version}</span>
          )}
        </span>
        {template.runs[0]?.ended_at && (
          <span className="gym-tpl-card-lifecycle">Last done {fmtLifecycleDate(template.runs[0].ended_at)}</span>
        )}
        {items.length === 0 ? (
          <span className="gym-tpl-card-empty">No exercises yet</span>
        ) : (
          <ul className="gym-tpl-card-items">
            {preview.map((it, i) => (
              <li key={i} className="gym-tpl-card-item">
                <span className="gym-tpl-card-item-name">{it.exercise_name}</span>
                <span className="gym-tpl-card-item-target tabular-nums">
                  {it.target_sets ?? '—'}×{it.target_reps ?? '—'}
                </span>
              </li>
            ))}
            {items.length > PREVIEW_LIMIT && (
              <li className="gym-tpl-card-more">+{items.length - PREVIEW_LIMIT} more</li>
            )}
          </ul>
        )}
      </div>
      <div className="gym-tpl-card-foot">
        <span className="gym-tpl-card-meta tabular-nums">Done {usageCount}×</span>
        <span className="gym-tpl-card-actions">
          <button
            type="button"
            className="gym-quiet-action"
            onClick={(event) => {
              event.stopPropagation()
              onUnarchive()
            }}
          >
            Unarchive
          </button>
          <DeleteAction templateId={template.id} />
        </span>
      </div>
    </div>
  )
}

// ── Recovery plans: structured, logging-capable templates ─────────────────

function RecoveryTemplateCard({
  template,
  onView
}: {
  template: RecoveryLogTemplate
  onView: () => void
}): ReactElement {
  const overview = template.summary?.trim()
  const overviewPreview = overview
    ? recoveryOverviewPreview(overview, RECOVERY_OVERVIEW_PREVIEW_CHARS)
    : null
  return (
    <div
      className="gym-rp-card"
      role="button"
      tabIndex={0}
      aria-label={`View ${template.name} recovery template`}
      onClick={onView}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onView()
        }
      }}
    >
      <div className="gym-rp-head">
        <span className="gym-rp-name">{template.name}</span>
        <span className="gym-rp-kind">Recovery template</span>
      </div>
      <div className="gym-rp-block">
        <p className={overview ? 'gym-rp-summary' : 'gym-rp-empty'}>
          {overviewPreview || 'No plan overview yet.'}
        </p>
      </div>
    </div>
  )
}

function RecoveryPlansSection({
  templates,
  onView
}: {
  templates: RecoveryLogTemplate[]
  onView: (template: RecoveryLogTemplate) => void
}): ReactElement | null {
  // Only show a card for injuries that actually have an active recovery plan
  // — an injury with no plan started yet shouldn't surface a card here.
  const loggable = templates.filter(hasActivePlan)
  if (loggable.length === 0) return null
  return (
    <section className="gym-section">
      <div className="gym-section-head gym-rp-section-head">
        <div>
          <h2 className="gym-section-title">Recovery plans</h2>
          <p className="gym-rp-section-copy">Linked rehab exercises can be inserted directly into any Gym log.</p>
        </div>
      </div>
      <div className="gym-rp-grid">
        {loggable.map((template) => (
          <RecoveryTemplateCard
            key={template.id}
            template={template}
            onView={() => onView(template)}
          />
        ))}
      </div>
    </section>
  )
}

/** Completed/archived templates, kept out of the active grid but still reachable. */
function ArchiveSection({
  templates,
  usageById,
  onView
}: {
  templates: GymTemplate[]
  usageById: Map<string, number>
  onView: (template: GymTemplate) => void
}): ReactElement | null {
  const unarchiveMutation = useUpdateGymTemplate()
  if (templates.length === 0) return null
  return (
    <section className="gym-section">
      <div className="gym-section-head">
        <h2 className="gym-section-title">Archive</h2>
      </div>
      <div className="gym-tpl-grid gym-tpl-grid--archived">
        {templates.map((t) => (
          <ArchivedTemplateCard
            key={t.id}
            template={t}
            usageCount={usageById.get(t.id) ?? 0}
            onView={() => onView(t)}
            onUnarchive={() => unarchiveMutation.mutate({ id: t.id, patch: { archived: false } })}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Templates sub-tab. Uniform rectangular cards whose full surface opens the
 * read-only view; editing happens from there. Recovery plans are separate
 * logging-capable templates sourced from active injury plans. Marking a
 * template complete archives it out of the active grid; archived templates
 * live in the Archive section below Recovery plans until unarchived/deleted.
 */
export function GymTemplatesTab({
  templates,
  recoveryTemplates,
  usageById,
  onView,
  onNew,
  onUseRecovery
}: {
  templates: GymTemplate[]
  recoveryTemplates: RecoveryLogTemplate[]
  usageById: Map<string, number>
  onView: (template: GymTemplate) => void
  onNew: () => void
  onUseRecovery: (template: RecoveryLogTemplate) => void
}): ReactElement {
  const [recoveryView, setRecoveryView] = useState<RecoveryLogTemplate | null>(null)
  const active = templates.filter((t) => !t.archived)
  const archived = templates.filter((t) => t.archived)

  // Card order is frontend-only (no backend write) and scoped to the active
  // templates grid only — Archive and Recovery plans keep their own order.
  const activeIds = useMemo(() => active.map((t) => t.id), [active])
  const cardOrder = useCardOrder('gym:templates:active:order', activeIds)
  const activeById = useMemo(() => new Map(active.map((t) => [t.id, t])), [active])
  const orderedActive = cardOrder.orderedIds
    .map((id) => activeById.get(id))
    .filter((t): t is GymTemplate => t != null)

  const [draggedId, setDraggedId] = useState<string | null>(null)

  return (
    <div className="gym-subtab">
      <section className="gym-section">
        <div className="gym-section-head">
          <h2 className="gym-section-title">Templates</h2>
          <ButtonSoft onClick={onNew}>New template</ButtonSoft>
        </div>

        {active.length === 0 ? (
          <EmptyState
            message="Templates prefill a session log with your usual exercises, sets, and targets — create one to speed up logging."
            action={<ButtonSoft onClick={onNew}>New template</ButtonSoft>}
          />
        ) : (
          <div className="gym-tpl-grid">
            {orderedActive.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                usageCount={usageById.get(t.id) ?? 0}
                onView={() => onView(t)}
                reorder={{
                  dragging: draggedId === t.id,
                  isFirst: cardOrder.isFirst(t.id),
                  isLast: cardOrder.isLast(t.id),
                  onDragStart: (e) => {
                    setDraggedId(t.id)
                    e.dataTransfer.effectAllowed = 'move'
                  },
                  onDragEnd: () => setDraggedId(null),
                  onDragOver: (e) => {
                    if (draggedId == null || draggedId === t.id) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  },
                  onDrop: (e) => {
                    e.preventDefault()
                    if (draggedId == null || draggedId === t.id) return
                    cardOrder.moveBefore(draggedId, t.id)
                    setDraggedId(null)
                  },
                  onMoveUp: () => cardOrder.moveUp(t.id),
                  onMoveDown: () => cardOrder.moveDown(t.id)
                }}
              />
            ))}
          </div>
        )}
      </section>

      <RecoveryPlansSection templates={recoveryTemplates} onView={setRecoveryView} />

      <ArchiveSection templates={archived} usageById={usageById} onView={onView} />

      {recoveryView && (
        <RecoveryTemplateViewModal
          template={recoveryView}
          onUse={() => {
            const template = recoveryView
            setRecoveryView(null)
            onUseRecovery(template)
          }}
          onClose={() => setRecoveryView(null)}
        />
      )}
    </div>
  )
}
