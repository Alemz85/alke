import { useState, type ReactElement } from 'react'
import { Timer } from 'lucide-react'
import type { GymTemplate } from '@shared/types'
import { ButtonSoft } from '../../components/ButtonSoft'
import { EmptyState } from '../../components/EmptyState'
import {
  useCompleteGymTemplateRun,
  useDeleteGymTemplate,
  useStartGymTemplateRun,
  useUpdateGymTemplate
} from '../../hooks/useGymData'
import { formatRest } from '../../lib/gymLog'
import { recoveryOverviewPreview, type RecoveryLogTemplate } from '../../lib/recoveryLogTemplates'
import { RecoveryTemplateViewModal } from './RecoveryTemplateViewModal'

const PREVIEW_LIMIT = 4
const RECOVERY_OVERVIEW_PREVIEW_CHARS = 180

function fmtLifecycleDate(dateIso: string): string {
  // dateIso is YYYY-MM-DD; parse as local to avoid off-by-one from UTC parsing.
  const [y, m, d] = dateIso.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function TemplateCard({
  template,
  usageCount,
  onView,
  onUnarchive
}: {
  template: GymTemplate
  usageCount: number
  onView: () => void
  onUnarchive?: () => void
}): ReactElement {
  const items = [...template.items].sort((a, b) => a.position - b.position)
  const preview = items.slice(0, PREVIEW_LIMIT)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteMutation = useDeleteGymTemplate()
  const startRunMutation = useStartGymTemplateRun()
  const completeRunMutation = useCompleteGymTemplateRun()

  const latestRun = template.runs[0]
  const isActive = latestRun != null && latestRun.ended_at === null
  const lifecyclePending = startRunMutation.isPending || completeRunMutation.isPending

  return (
    <div
      className={`gym-tpl-card${template.archived ? ' gym-tpl-card--archived' : ''}`}
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
              className="gym-quiet-action"
              disabled={lifecyclePending}
              onClick={(event) => {
                event.stopPropagation()
                completeRunMutation.mutate(template.id)
              }}
            >
              {completeRunMutation.isPending ? 'Completing…' : 'Mark complete'}
            </button>
          ) : (
            <button
              type="button"
              className="gym-quiet-action"
              disabled={lifecyclePending}
              onClick={(event) => {
                event.stopPropagation()
                startRunMutation.mutate(template.id)
              }}
            >
              {startRunMutation.isPending ? 'Starting…' : latestRun ? 'Resurrect' : 'Start'}
            </button>
          )}
          {onUnarchive && (
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
          )}
          {!confirmDelete ? (
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
          ) : (
            <span className="gym-tpl-card-confirm" onClick={(event) => event.stopPropagation()}>
              <span className="gym-delete-confirm-label">Delete?</span>
              <button
                type="button"
                className="gym-quiet-action gym-quiet-action--danger"
                disabled={deleteMutation.isPending}
                onClick={(event) => {
                  event.stopPropagation()
                  deleteMutation.mutate(template.id)
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
          )}
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
  if (templates.length === 0) return null
  return (
    <section className="gym-section">
      <div className="gym-section-head gym-rp-section-head">
        <div>
          <h2 className="gym-section-title">Recovery plans</h2>
          <p className="gym-rp-section-copy">Linked rehab exercises can be inserted directly into any Gym log.</p>
        </div>
      </div>
      <div className="gym-rp-grid">
        {templates.map((template) => (
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

/**
 * Templates sub-tab. Uniform rectangular cards whose full surface opens the
 * read-only view. A click
 * opens the read-only view; editing happens from there. Recovery plans are
 * separate logging-capable templates sourced from active injury plans.
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
  const [showArchived, setShowArchived] = useState(false)
  const [recoveryView, setRecoveryView] = useState<RecoveryLogTemplate | null>(null)
  const active = templates.filter((t) => !t.archived)
  const archived = templates.filter((t) => t.archived)
  const unarchiveMutation = useUpdateGymTemplate()

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
            {active.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                usageCount={usageById.get(t.id) ?? 0}
                onView={() => onView(t)}
              />
            ))}
          </div>
        )}

        {archived.length > 0 &&
          (!showArchived ? (
            <button type="button" className="gym-quiet-action" onClick={() => setShowArchived(true)}>
              Show archived ({archived.length})
            </button>
          ) : (
            <div className="gym-tpl-grid gym-tpl-grid--archived">
              {archived.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  usageCount={usageById.get(t.id) ?? 0}
                  onView={() => onView(t)}
                  onUnarchive={() => unarchiveMutation.mutate({ id: t.id, patch: { archived: false } })}
                />
              ))}
            </div>
          ))}
      </section>

      <RecoveryPlansSection templates={recoveryTemplates} onView={setRecoveryView} />

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
