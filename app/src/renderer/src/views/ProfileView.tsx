import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, X } from 'lucide-react'
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis
} from 'recharts'
import type { Goal, GoalPatch, GoalProgressPoint, NewGoal, UserConfigPatch, Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import { ButtonSoft, EmptyState, MetricCard } from '../components'
import {
  achievements,
  metricProgress,
  profileStats,
  sinceLabel,
  timeProgress,
  type Achievement
} from '../lib/profileStats'
import { applyGoalPatch, replaceById } from '../lib/optimisticEntities'
import './ProfileView.css'

const ABOUT_ME_MAX = 5000

const tooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
}

function formatDate(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ymd
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatHours(h: number): string {
  return h < 10 ? h.toFixed(1) : String(Math.round(h))
}

// ── stats row ─────────────────────────────────────────────────────────────────

function StatsRow({ workouts, now }: { workouts: Workout[]; now: Date }): ReactElement {
  const stats = useMemo(() => profileStats(workouts, now), [workouts, now])
  return (
    <div className="profile-stats-row">
      <MetricCard eyebrow="Workouts" value={String(stats.workoutCount)} />
      <MetricCard eyebrow="Total hours" value={formatHours(stats.totalHours)} />
      <MetricCard eyebrow="Swim distance" value={`${stats.totalSwimKm.toFixed(1)} km`} />
      <MetricCard
        eyebrow="Streak"
        value={`${stats.currentStreakWeeks} wk`}
        caption={`longest ${stats.longestStreakWeeks} wk`}
      />
      <MetricCard eyebrow="Tracking since" value={formatDate(stats.trackingSince)} />
    </div>
  )
}

// ── achievements ─────────────────────────────────────────────────────────────

function AchievementBadge({ achievement }: { achievement: Achievement }): ReactElement {
  return (
    <div className={`profile-badge${achievement.earned ? '' : ' profile-badge--locked'}`}>
      {!achievement.earned && <Lock size={12} strokeWidth={1.75} className="profile-badge-lock" />}
      <span className="profile-badge-title">{achievement.title}</span>
      <span className="profile-badge-desc">{achievement.description}</span>
      {achievement.earned && achievement.earnedDate && (
        <span className="profile-badge-date tabular-nums">{formatDate(achievement.earnedDate)}</span>
      )}
    </div>
  )
}

function AchievementsSection({ workouts, now }: { workouts: Workout[]; now: Date }): ReactElement {
  const list = useMemo(() => achievements(workouts, now), [workouts, now])
  return (
    <section className="profile-section">
      <h2 className="profile-section-title">Achievements</h2>
      <div className="profile-badge-grid">
        {list.map((a) => (
          <AchievementBadge key={a.id} achievement={a} />
        ))}
      </div>
    </section>
  )
}

// ── about me ─────────────────────────────────────────────────────────────────

function AboutMeSection(): ReactElement {
  const queryClient = useQueryClient()
  const configQuery = useQuery({
    queryKey: ['userConfig'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })

  const loaded = configQuery.data
  const [draft, setDraft] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [savedVisible, setSavedVisible] = useState(false)

  // Hydrate the draft once loaded, and re-hydrate whenever a fresh value
  // arrives while not actively editing (mirrors SettingsView's draft pattern).
  useEffect(() => {
    if (loaded !== undefined && !editing) {
      setDraft(loaded?.about_me ?? '')
    }
  }, [loaded, editing])

  const mutation = useMutation({
    mutationFn: (patch: UserConfigPatch) => window.api.updateUserConfig(patch),
    meta: { errorMessage: 'Couldn’t save About me. Your edit is still in the box — try again.' },
    onSuccess: (fresh) => {
      queryClient.setQueryData(['userConfig'], fresh)
      setEditing(false)
      setSavedVisible(true)
    }
  })

  useEffect(() => {
    if (!savedVisible) return
    const t = setTimeout(() => setSavedVisible(false), 2000)
    return () => clearTimeout(t)
  }, [savedVisible])

  const savedValue = loaded?.about_me ?? ''
  const isDirty = draft != null && draft !== savedValue
  const overLimit = (draft?.length ?? 0) > ABOUT_ME_MAX

  const handleSave = (): void => {
    if (draft == null || !isDirty || overLimit) return
    mutation.mutate({ about_me: draft.trim() === '' ? null : draft })
  }

  const handleCancel = (): void => {
    setDraft(savedValue)
    setEditing(false)
  }

  if (configQuery.isLoading || draft === null) {
    return (
      <section className="profile-section">
        <h2 className="profile-section-title">About me</h2>
        <p className="profile-loading">Loading…</p>
      </section>
    )
  }

  return (
    <section className="profile-section">
      <h2 className="profile-section-title">About me</h2>
      <p className="profile-field-hint profile-about-hint">
        Free text the AI reads for context — training background, constraints, preferences,
        anything worth knowing while it coaches you.
      </p>

      {!editing && savedValue.trim() === '' ? (
        <EmptyState
          message="Nothing here yet. Add a few notes about yourself so the AI has context."
          action={<ButtonSoft onClick={() => setEditing(true)}>Add about me</ButtonSoft>}
        />
      ) : editing ? (
        <div className="profile-about-edit">
          <textarea
            className="profile-textarea profile-about-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            maxLength={ABOUT_ME_MAX}
            autoFocus
            placeholder="Training background, constraints, preferences…"
          />
          <div className="profile-about-edit-foot">
            <span
              className={`profile-about-count tabular-nums${overLimit ? ' profile-about-count--over' : ''}`}
            >
              {draft.length} / {ABOUT_ME_MAX}
            </span>
            <div className="profile-about-actions">
              <button
                type="button"
                className="profile-btn"
                onClick={handleCancel}
                disabled={mutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="profile-btn profile-btn--primary"
                onClick={handleSave}
                disabled={!isDirty || overLimit || mutation.isPending}
              >
                {mutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          {mutation.isError && <p className="profile-about-error">Couldn’t save. Try again.</p>}
        </div>
      ) : (
        <div className="profile-about-view" onClick={() => setEditing(true)}>
          <p className="profile-about-text">{savedValue}</p>
          <div className="profile-about-view-foot">
            <ButtonSoft onClick={() => setEditing(true)}>Edit</ButtonSoft>
            <span
              className={savedVisible ? 'profile-about-saved profile-about-saved--visible' : 'profile-about-saved'}
              role="status"
              aria-live="polite"
            >
              Saved
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

// ── goal progress chart ──────────────────────────────────────────────────────

function GoalProgressChart({
  points,
  height = 80
}: {
  points: GoalProgressPoint[]
  height?: number
}): ReactElement {
  const data = [...points]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((p) => ({ date: p.date, value: p.value }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <XAxis dataKey="date" hide />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(d: string) => formatDate(d)}
          formatter={(v) => (typeof v === 'number' ? v.toLocaleString() : v)}
        />
        <defs>
          <linearGradient id="profile-goal-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-text-secondary)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--color-text-secondary)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-text-secondary)"
          strokeWidth={1.5}
          fill="url(#profile-goal-fill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// ── goal metric block ────────────────────────────────────────────────────────

function GoalMetricBlock({
  goal,
  showDescription,
  chartHeight = 80
}: {
  goal: Goal
  showDescription: boolean
  chartHeight?: number
}): ReactElement {
  const queryClient = useQueryClient()

  const progressQuery = useQuery({
    queryKey: ['goal-progress', goal.id],
    queryFn: () => window.api.getGoalProgress(goal.id),
    staleTime: 60_000,
    enabled: goal.metric_name != null
  })

  const buildMutation = useMutation({
    mutationFn: () => window.api.buildGoalMetric(goal.id),
    meta: { errorMessage: 'Couldn’t generate the goal metric. You can retry from the goal card.' },
    onSuccess: (res) => {
      if (res.ok) {
        void queryClient.invalidateQueries({ queryKey: ['goals'] })
        void queryClient.invalidateQueries({ queryKey: ['goal-progress', goal.id] })
      }
    }
  })

  // Pending state: no metric yet, and nothing has failed.
  if (goal.metric_sql == null) {
    if (buildMutation.isPending) {
      return (
        <div className="profile-goal-metric profile-goal-metric--pending">
          <p className="profile-metric-empty">
            Agent is designing the metric — this can take a few minutes.
          </p>
        </div>
      )
    }
    const failed = buildMutation.isSuccess && !buildMutation.data.ok
    return (
      <div className="profile-goal-metric profile-goal-metric--pending">
        <p className="profile-metric-empty">
          {failed
            ? (buildMutation.data.error ?? 'The agent could not build a metric.')
            : buildMutation.isError
              ? 'The agent run failed to start.'
              : 'No progress metric yet.'}
        </p>
        <ButtonSoft onClick={() => buildMutation.mutate()} disabled={buildMutation.isPending}>
          {failed || buildMutation.isError ? 'Retry' : 'Build with agent'}
        </ButtonSoft>
      </div>
    )
  }

  const points = progressQuery.data ?? []
  const { latest, delta, pctToTarget } = metricProgress(goal, points)

  return (
    <div className="profile-goal-metric">
      <div className="profile-goal-metric-head">
        <span className="profile-goal-metric-name">{goal.metric_name}</span>
        {latest != null && (
          <span className="profile-goal-metric-value tabular-nums">
            {latest.toLocaleString()}
            {goal.metric_unit ? ` ${goal.metric_unit}` : ''}
          </span>
        )}
      </div>

      {(goal.metric_baseline != null || goal.metric_target != null) && (
        <div className="profile-goal-metric-range tabular-nums">
          {goal.metric_baseline != null ? goal.metric_baseline.toLocaleString() : '—'}
          {' → '}
          {goal.metric_target != null ? goal.metric_target.toLocaleString() : '—'}
          {goal.metric_unit ? ` ${goal.metric_unit}` : ''}
          {delta != null && (
            <span className="profile-goal-metric-delta">
              {' '}
              ({delta >= 0 ? '+' : ''}
              {delta.toLocaleString()} vs baseline)
            </span>
          )}
        </div>
      )}

      {pctToTarget != null && (
        <div className="profile-goal-bar" role="progressbar" aria-valuenow={pctToTarget} aria-valuemin={0} aria-valuemax={100}>
          <div className="profile-goal-bar-fill" style={{ width: `${pctToTarget}%` }} />
        </div>
      )}

      {points.length > 1 ? (
        <GoalProgressChart points={points} height={chartHeight} />
      ) : (
        !progressQuery.isLoading && <p className="profile-metric-empty">Not enough data points yet.</p>
      )}

      {showDescription && goal.metric_description && (
        <p className="profile-goal-metric-desc">{goal.metric_description}</p>
      )}
    </div>
  )
}

// ── goal card ─────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<Goal['status'], string> = {
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  abandoned: 'Abandoned'
}

function GoalHead({ goal }: { goal: Goal }): ReactElement {
  return (
    <div className="profile-goal-head">
      <h3 className="profile-goal-title">{goal.title}</h3>
      <div className="profile-goal-badges">
        <span className={`badge profile-goal-status profile-goal-status--${goal.status}`}>
          {STATUS_LABEL[goal.status]}
        </span>
        {goal.created_by === 'chat' && <span className="profile-goal-via">via chat</span>}
      </div>
    </div>
  )
}

function GoalMeta({ goal, now }: { goal: Goal; now: Date }): ReactElement {
  const tp = timeProgress(goal, now)
  const since = sinceLabel(goal, now)
  return (
    <>
      <div className="profile-goal-meta">
        <span className="tabular-nums">
          {since.text} {formatDate(since.anchorYMD)}
        </span>
        {goal.duration_days != null ? (
          <span className="tabular-nums">
            day {Math.min(tp.elapsedDays + 1, goal.duration_days)} of {goal.duration_days}
          </span>
        ) : goal.status === 'active' || goal.status === 'on_hold' ? (
          <span>Open-ended</span>
        ) : null}
      </div>

      {goal.duration_days != null && tp.pct != null && (
        <div className="profile-goal-bar profile-goal-bar--time">
          <div className="profile-goal-bar-fill" style={{ width: `${tp.pct}%` }} />
        </div>
      )}
    </>
  )
}

function useOptimisticGoalUpdate(goalId: string, errorMessage: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: GoalPatch) => window.api.updateGoal(goalId, patch),
    scope: { id: 'goals' },
    meta: { errorMessage },
    onMutate: async (patch) => {
      const queryKey = ['goals'] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<Goal[]>(queryKey)
      queryClient.setQueryData<Goal[]>(queryKey, (goals = []) =>
        applyGoalPatch(goals, goalId, patch)
      )
      return { previous }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Goal[]>(['goals'], (goals = []) =>
        replaceById(goals, goalId, saved)
      )
    },
    onError: (_error, _patch, context) => {
      queryClient.setQueryData(['goals'], context?.previous)
    }
  })
}

function GoalActions({ goal, onEdit }: { goal: Goal; onEdit: () => void }): ReactElement {
  const statusMutation = useOptimisticGoalUpdate(
    goal.id,
    'Couldn’t update the goal status. The previous status was restored.'
  )

  const set = (status: Goal['status']): void => statusMutation.mutate({ status })
  const pending = statusMutation.isPending

  return (
    <div className="profile-goal-actions">
      <ButtonSoft onClick={onEdit}>Edit</ButtonSoft>
      {goal.status === 'active' ? (
        <>
          <ButtonSoft onClick={() => set('completed')} disabled={pending}>
            Complete
          </ButtonSoft>
          <ButtonSoft onClick={() => set('on_hold')} disabled={pending}>
            Hold
          </ButtonSoft>
          <ButtonSoft onClick={() => set('abandoned')} disabled={pending}>
            Abandon
          </ButtonSoft>
        </>
      ) : goal.status === 'on_hold' ? (
        <>
          <ButtonSoft onClick={() => set('active')} disabled={pending}>
            Resume
          </ButtonSoft>
          <ButtonSoft onClick={() => set('abandoned')} disabled={pending}>
            Abandon
          </ButtonSoft>
        </>
      ) : (
        <ButtonSoft onClick={() => set('active')} disabled={pending}>
          Reactivate
        </ButtonSoft>
      )}
    </div>
  )
}

function GoalCard({
  goal,
  now,
  onEdit,
  onOpen
}: {
  goal: Goal
  now: Date
  onEdit: () => void
  onOpen: () => void
}): ReactElement {
  const dimmed = goal.status === 'completed' || goal.status === 'abandoned'

  // Collapsed cards share a fixed height so the action rows line up; the full
  // content lives in the peek (click anywhere non-interactive to open it).
  const handleOpen = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    onOpen()
  }

  return (
    <div
      className={`profile-goal-card${dimmed ? ' profile-goal-card--inactive' : ''}`}
      onClick={handleOpen}
    >
      <GoalHead goal={goal} />
      <GoalMeta goal={goal} now={now} />

      {goal.description && <p className="profile-goal-desc">{goal.description}</p>}

      <GoalMetricBlock goal={goal} showDescription={false} />

      <GoalActions goal={goal} onEdit={onEdit} />
    </div>
  )
}

// ── goal detail peek (Notion-style centered pop-out of a card) ───────────────

function GoalDetailModal({
  goal,
  now,
  onEdit,
  onClose
}: {
  goal: Goal
  now: Date
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

  return (
    <div className="profile-modal-overlay" onClick={onClose}>
      <div
        className="profile-modal profile-modal--detail"
        role="dialog"
        aria-modal="true"
        aria-label={goal.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="profile-modal-head">
          <GoalHead goal={goal} />
          <button type="button" className="profile-modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className="profile-goal-detail-body">
          <GoalMeta goal={goal} now={now} />

          {goal.description && (
            <p className="profile-goal-desc profile-goal-desc--expanded">{goal.description}</p>
          )}

          <GoalMetricBlock goal={goal} showDescription chartHeight={160} />

          <GoalActions goal={goal} onEdit={onEdit} />
        </div>
      </div>
    </div>
  )
}

// ── new/edit goal modal ──────────────────────────────────────────────────────

interface GoalModalProps {
  goal: Goal | null
  onClose: () => void
}

function GoalModal({ goal, onClose }: GoalModalProps): ReactElement {
  const queryClient = useQueryClient()
  const isEdit = goal != null

  const [title, setTitle] = useState(goal?.title ?? '')
  const [description, setDescription] = useState(goal?.description ?? '')
  const [startedAt, setStartedAt] = useState(goal?.started_at.slice(0, 10) ?? new Date().toISOString().slice(0, 10))
  const [durationWeeks, setDurationWeeks] = useState<string>(
    goal?.duration_days != null ? String(Math.round(goal.duration_days / 7)) : ''
  )

  const buildMutation = useMutation({
    mutationFn: (goalId: string) => window.api.buildGoalMetric(goalId),
    meta: { errorMessage: 'The goal was saved, but its progress metric could not be generated.' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goals'] })
    }
  })

  const createMutation = useMutation({
    mutationFn: (newGoal: NewGoal) => window.api.addGoal(newGoal),
    meta: { errorMessage: 'Couldn’t create the goal. Your draft is still open.' },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['goals'] })
      // The agent activates once the card is done being compiled: fire the
      // metric build immediately after creation.
      buildMutation.mutate(created.id)
      onClose()
    }
  })

  const updateMutation = useOptimisticGoalUpdate(
    (goal as Goal | null)?.id ?? 'new',
    'Couldn’t update the goal. Your previous version was restored.'
  )

  const pending = createMutation.isPending || updateMutation.isPending

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (!title.trim()) return
    const weeks = durationWeeks.trim() === '' ? null : Number(durationWeeks)
    const duration_days = weeks != null && weeks > 0 ? Math.round(weeks * 7) : null

    if (isEdit) {
      updateMutation.mutate({
        title: title.trim(),
        description: description.trim() || null,
        duration_days
      })
      onClose()
    } else {
      createMutation.mutate({
        title: title.trim(),
        description: description.trim() || null,
        duration_days,
        started_at: startedAt
      })
    }
  }

  return (
    <div className="profile-modal-overlay" onClick={onClose}>
      <div
        className="profile-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit goal' : 'New goal'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="profile-modal-head">
          <h3 className="profile-modal-title">{isEdit ? 'Edit goal' : 'New goal'}</h3>
          <button type="button" className="profile-modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <form className="profile-modal-body" onSubmit={handleSubmit}>
          <label className="profile-field">
            <span className="profile-field-label">Title</span>
            <input
              className="profile-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>

          <label className="profile-field">
            <span className="profile-field-label">Description</span>
            <textarea
              className="profile-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Optional — the agent can write or polish this for you."
            />
            <span className="profile-field-hint">
              Optional. The agent can write or polish this prose from a chat conversation.
            </span>
          </label>

          {!isEdit && (
            <label className="profile-field">
              <span className="profile-field-label">Start date</span>
              <input
                className="profile-input"
                type="date"
                value={startedAt}
                onChange={(e) => setStartedAt(e.target.value)}
              />
            </label>
          )}

          <label className="profile-field">
            <span className="profile-field-label">Duration (weeks)</span>
            <input
              className="profile-input"
              type="number"
              min={1}
              value={durationWeeks}
              onChange={(e) => setDurationWeeks(e.target.value)}
              placeholder="No end date"
            />
          </label>

          <div className="profile-modal-actions">
            <button type="submit" className="profile-btn profile-btn--primary" disabled={pending || !title.trim()}>
              {pending ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save' : 'Create'}
            </button>
            <button type="button" className="profile-btn" onClick={onClose} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── goals section ────────────────────────────────────────────────────────────

type GoalTabKey = 'active' | 'archive'

/** Compact archive row — mirrors InjuriesView's history table. */
function GoalArchiveRow({ goal, now, onOpen }: { goal: Goal; now: Date; onOpen: () => void }): ReactElement {
  const since = sinceLabel(goal, now)
  return (
    <tr className="profile-archive-row" onClick={onOpen}>
      <td>{goal.title}</td>
      <td>
        <span className={`badge profile-goal-status profile-goal-status--${goal.status}`}>
          {STATUS_LABEL[goal.status]}
        </span>
      </td>
      <td className="tabular-nums">
        {since.text} {formatDate(since.anchorYMD)}
      </td>
      <td className="tabular-nums">{formatDate(goal.started_at)}</td>
    </tr>
  )
}

function GoalsSection({ goals, now }: { goals: Goal[]; now: Date }): ReactElement {
  const [tab, setTab] = useState<GoalTabKey>('active')
  const [modalGoal, setModalGoal] = useState<Goal | null | 'new'>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const active = goals.filter((g) => g.status === 'active' || g.status === 'on_hold')
  const archive = goals.filter((g) => g.status === 'completed' || g.status === 'abandoned')

  // Resolve from the live list so mutations inside the peek stay fresh.
  const detailGoal = detailId != null ? (goals.find((g) => g.id === detailId) ?? null) : null

  const openEdit = (goal: Goal): void => {
    setDetailId(null)
    setModalGoal(goal)
  }

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h2 className="profile-section-title">Goals</h2>
        <ButtonSoft onClick={() => setModalGoal('new')}>New goal</ButtonSoft>
      </div>

      {goals.length === 0 ? (
        <EmptyState
          message="No goals yet. Declare a goal — title, a few words on what you're after, an optional duration — and the agent will build a progress metric for it."
          action={<ButtonSoft onClick={() => setModalGoal('new')}>New goal</ButtonSoft>}
        />
      ) : (
        <>
          <div className="profile-tabs" role="tablist" aria-label="Goal status">
            <button
              role="tab"
              aria-selected={tab === 'active'}
              className={tab === 'active' ? 'chip chip--active' : 'chip'}
              onClick={() => setTab('active')}
            >
              Active
            </button>
            <button
              role="tab"
              aria-selected={tab === 'archive'}
              className={tab === 'archive' ? 'chip chip--active' : 'chip'}
              onClick={() => setTab('archive')}
            >
              Archive
            </button>
          </div>

          {tab === 'active' ? (
            active.length === 0 ? (
              <EmptyState message="No active goals. Reactivate one from the archive, or start a new one." />
            ) : (
              <div className="profile-goal-grid">
                {active.map((g) => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    now={now}
                    onEdit={() => openEdit(g)}
                    onOpen={() => setDetailId(g.id)}
                  />
                ))}
              </div>
            )
          ) : archive.length === 0 ? (
            <EmptyState message="No completed or abandoned goals yet." />
          ) : (
            <div className="profile-archive-wrap">
              <table className="profile-archive-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Since</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {archive.map((g) => (
                    <GoalArchiveRow key={g.id} goal={g} now={now} onOpen={() => setDetailId(g.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {detailGoal != null && (
        <GoalDetailModal
          goal={detailGoal}
          now={now}
          onEdit={() => openEdit(detailGoal)}
          onClose={() => setDetailId(null)}
        />
      )}

      {modalGoal != null && (
        <GoalModal goal={modalGoal === 'new' ? null : modalGoal} onClose={() => setModalGoal(null)} />
      )}
    </section>
  )
}

// ── view ─────────────────────────────────────────────────────────────────────

export function ProfileView(): ReactElement {
  const [section, setSection] = useState<'goals' | 'stats'>('goals')
  const now = useMemo(() => new Date(), [])
  const yearsAgo = useMemo(() => {
    const d = new Date()
    d.setFullYear(d.getFullYear() - 10)
    return d.toISOString()
  }, [])

  const workoutsQuery = useQuery({
    queryKey: ['profile', 'workouts'],
    queryFn: () => window.api.getWorkouts(yearsAgo, new Date().toISOString()),
    staleTime: 60_000
  })
  const goalsQuery = useQuery({
    queryKey: ['goals'],
    queryFn: () => window.api.getGoals(),
    staleTime: 60_000
  })

  const workouts = workoutsQuery.data ?? []
  const goals = goalsQuery.data ?? []

  const loading = workoutsQuery.isLoading || goalsQuery.isLoading
  const error = workoutsQuery.isError || goalsQuery.isError

  return (
    <div className="view">
      <TabHeader eyebrow="You" title="Profile" />

      <div className="profile-tabs" role="tablist" aria-label="Profile sections">
        <button
          role="tab"
          aria-selected={section === 'goals'}
          className={section === 'goals' ? 'profile-tab profile-tab--active' : 'profile-tab'}
          onClick={() => setSection('goals')}
        >
          Goals
        </button>
        <button
          role="tab"
          aria-selected={section === 'stats'}
          className={section === 'stats' ? 'profile-tab profile-tab--active' : 'profile-tab'}
          onClick={() => setSection('stats')}
        >
          Stats & achievements
        </button>
      </div>

      {error ? (
        <p className="profile-error">Could not load profile data.</p>
      ) : loading ? (
        <p className="profile-loading">Loading…</p>
      ) : section === 'goals' ? (
        <>
          <AboutMeSection />
          <GoalsSection goals={goals} now={now} />
        </>
      ) : (
        <>
          <StatsRow workouts={workouts} now={now} />
          <AchievementsSection workouts={workouts} now={now} />
        </>
      )}
    </div>
  )
}
