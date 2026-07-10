import {
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
import type { Goal, GoalPatch, GoalProgressPoint, NewGoal, Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import { ButtonSoft, EmptyState, MetricCard } from '../components'
import { achievements, metricProgress, profileStats, timeProgress, type Achievement } from '../lib/profileStats'
import './ProfileView.css'

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

// ── goal progress chart ──────────────────────────────────────────────────────

function GoalProgressChart({ points }: { points: GoalProgressPoint[] }): ReactElement {
  const data = [...points]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((p) => ({ date: p.date, value: p.value }))
  return (
    <ResponsiveContainer width="100%" height={80}>
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
  showDescription
}: {
  goal: Goal
  showDescription: boolean
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
        <GoalProgressChart points={points} />
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

function GoalCard({
  goal,
  now,
  onEdit
}: {
  goal: Goal
  now: Date
  onEdit: () => void
}): ReactElement {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)

  const statusMutation = useMutation({
    mutationFn: (patch: GoalPatch) => window.api.updateGoal(goal.id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] })
  })

  const tp = timeProgress(goal, now)
  const isActive = goal.status === 'active'
  const isOnHold = goal.status === 'on_hold'

  // The whole card toggles expansion (collapsed cards share a fixed height, so
  // overflow is cropped) — except clicks on its interactive children.
  const toggleExpand = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    setExpanded((v) => !v)
  }

  return (
    <div
      className={`profile-goal-card${isActive || isOnHold ? '' : ' profile-goal-card--inactive'}${expanded ? ' profile-goal-card--expanded' : ''}`}
      onClick={toggleExpand}
      aria-expanded={expanded}
    >
      <div className="profile-goal-head">
        <h3 className="profile-goal-title">{goal.title}</h3>
        <div className="profile-goal-badges">
          <span className={`badge profile-goal-status profile-goal-status--${goal.status}`}>
            {STATUS_LABEL[goal.status]}
          </span>
          {goal.created_by === 'chat' && <span className="profile-goal-via">via chat</span>}
        </div>
      </div>

      <div className="profile-goal-meta">
        <span>Started {formatDate(goal.started_at)}</span>
        {goal.duration_days != null ? (
          <span className="tabular-nums">
            day {Math.min(tp.elapsedDays + 1, goal.duration_days)} of {goal.duration_days}
          </span>
        ) : (
          <span>Open-ended</span>
        )}
      </div>

      {goal.duration_days != null && tp.pct != null && (
        <div className="profile-goal-bar profile-goal-bar--time">
          <div className="profile-goal-bar-fill" style={{ width: `${tp.pct}%` }} />
        </div>
      )}

      {goal.description && (
        <p className={`profile-goal-desc${expanded ? ' profile-goal-desc--expanded' : ''}`}>
          {goal.description}
        </p>
      )}

      <GoalMetricBlock goal={goal} showDescription={expanded} />

      <div className="profile-goal-actions">
        <ButtonSoft onClick={onEdit}>Edit</ButtonSoft>
        {isActive ? (
          <>
            <ButtonSoft
              onClick={() => statusMutation.mutate({ status: 'completed' })}
              disabled={statusMutation.isPending}
            >
              Complete
            </ButtonSoft>
            <ButtonSoft
              onClick={() => statusMutation.mutate({ status: 'on_hold' })}
              disabled={statusMutation.isPending}
            >
              Hold
            </ButtonSoft>
            <ButtonSoft
              onClick={() => statusMutation.mutate({ status: 'abandoned' })}
              disabled={statusMutation.isPending}
            >
              Abandon
            </ButtonSoft>
          </>
        ) : isOnHold ? (
          <>
            <ButtonSoft
              onClick={() => statusMutation.mutate({ status: 'active' })}
              disabled={statusMutation.isPending}
            >
              Resume
            </ButtonSoft>
            <ButtonSoft
              onClick={() => statusMutation.mutate({ status: 'abandoned' })}
              disabled={statusMutation.isPending}
            >
              Abandon
            </ButtonSoft>
          </>
        ) : (
          <ButtonSoft
            onClick={() => statusMutation.mutate({ status: 'active' })}
            disabled={statusMutation.isPending}
          >
            Reactivate
          </ButtonSoft>
        )}
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goals'] })
    }
  })

  const createMutation = useMutation({
    mutationFn: (newGoal: NewGoal) => window.api.addGoal(newGoal),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['goals'] })
      // The agent activates once the card is done being compiled: fire the
      // metric build immediately after creation.
      buildMutation.mutate(created.id)
      onClose()
    }
  })

  const updateMutation = useMutation({
    mutationFn: (patch: GoalPatch) => window.api.updateGoal((goal as Goal).id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goals'] })
      onClose()
    }
  })

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
              {pending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
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

function GoalsSection({ goals, now }: { goals: Goal[]; now: Date }): ReactElement {
  const [modalGoal, setModalGoal] = useState<Goal | null | 'new'>(null)

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
        <div className="profile-goal-grid">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} now={now} onEdit={() => setModalGoal(g)} />
          ))}
        </div>
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
        <GoalsSection goals={goals} now={now} />
      ) : (
        <>
          <StatsRow workouts={workouts} now={now} />
          <AchievementsSection workouts={workouts} now={now} />
        </>
      )}
    </div>
  )
}
