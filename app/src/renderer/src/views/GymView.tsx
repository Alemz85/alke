import { useMemo, useState, type ReactElement } from 'react'
import type { Exercise, GymSession, GymTemplate, Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import { ButtonSoft } from '../components/ButtonSoft'
import { EmptyState } from '../components/EmptyState'
import { HeroMetric } from '../components/HeroMetric'
import { useUserConfig, useYearWorkouts } from '../hooks/useSessionsData'
import { useExercises, useGymSessions, useGymTemplates, useUpdateGymTemplate } from '../hooks/useGymData'
import { isoWeekKey, toZonedYMD } from '../hooks/sessionsDate'
import { displayBodyPart, isStrengthWorkout, sessionBodyParts, summarizeSession } from '../lib/gymLog'
import { EM_DASH, formatDurationHM } from '../lib/format'
import { SessionEditorModal, type EditorTarget } from './gym/SessionEditorModal'
import { TemplateEditorModal } from './gym/TemplateEditorModal'
import './GymView.css'

const TO_LOG_WINDOW_DAYS = 45
const HISTORY_WINDOW_DAYS = 90
const TO_LOG_CAP = 6

function formatDateShort(iso: string, timezone: string | null | undefined): string {
  const ymd = toZonedYMD(iso, timezone)
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12))
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function formatTime(iso: string, timezone: string | null | undefined): string {
  const tz = timezone || 'UTC'
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso)
  )
}

// ── hero ─────────────────────────────────────────────────────────────────────

function GymHero({
  strengthWorkoutsThisWeek,
  loggedThisWeek
}: {
  strengthWorkoutsThisWeek: Workout[]
  loggedThisWeek: number
}): ReactElement {
  const total = strengthWorkoutsThisWeek.length
  return (
    <HeroMetric
      eyebrow="Gym · This week"
      value={total.toString()}
      unit={total === 1 ? 'session' : 'sessions'}
      delta={`${loggedThisWeek} of ${total} logged`}
      domain="load"
    />
  )
}

// ── to-log section ───────────────────────────────────────────────────────────

function ToLogRow({
  workout,
  timezone,
  onLog
}: {
  workout: Workout
  timezone: string | null | undefined
  onLog: () => void
}): ReactElement {
  return (
    <div className="gym-tolog-row">
      <div className="gym-tolog-info">
        <span className="gym-tolog-date tabular-nums">{formatDateShort(workout.start_at, timezone)}</span>
        <span className="gym-tolog-time tabular-nums">{formatTime(workout.start_at, timezone)}</span>
        <span className="gym-tolog-duration tabular-nums">
          {formatDurationHM(workout.duration_s ?? 0)}
        </span>
        <span className="gym-tolog-hr tabular-nums">
          {workout.avg_hr !== null ? `${Math.round(workout.avg_hr)} bpm` : EM_DASH}
        </span>
      </div>
      <ButtonSoft onClick={onLog}>Log session</ButtonSoft>
    </div>
  )
}

function ToLogSection({
  unloggedWorkouts,
  timezone,
  lastLoggedDate,
  onLogWorkout,
  onLogUnlinked
}: {
  unloggedWorkouts: Workout[]
  timezone: string | null | undefined
  lastLoggedDate: string | null
  onLogWorkout: (workout: Workout) => void
  onLogUnlinked: () => void
}): ReactElement {
  const visible = unloggedWorkouts.slice(0, TO_LOG_CAP)
  const extra = unloggedWorkouts.length - visible.length

  return (
    <section className="gym-section">
      <h2 className="gym-section-title">To log</h2>
      {unloggedWorkouts.length === 0 ? (
        <EmptyState
          message={
            lastLoggedDate
              ? `All synced gym sessions are logged. Last one: ${lastLoggedDate}.`
              : 'All synced gym sessions are logged.'
          }
        />
      ) : (
        <div className="gym-tolog-list">
          {visible.map((w) => (
            <ToLogRow key={w.id} workout={w} timezone={timezone} onLog={() => onLogWorkout(w)} />
          ))}
          {extra > 0 && <p className="gym-tolog-more tabular-nums">+{extra} more</p>}
        </div>
      )}
      <button type="button" className="gym-quiet-action" onClick={onLogUnlinked}>
        Log a session without a synced workout
      </button>
    </section>
  )
}

// ── history section ──────────────────────────────────────────────────────────

/** "Legs · Core · Back +1" — derived body parts for a history row, subtle, max 3 shown. */
function bodyPartsLabel(session: GymSession, exercisesById: Map<string, Exercise>): string | null {
  if (session.sets.length === 0) return null // set-less logs already say it in the summary
  const parts = sessionBodyParts(session, exercisesById).map(displayBodyPart)
  if (parts.length === 0) return null
  const shown = parts.slice(0, 3).join(' · ')
  return parts.length > 3 ? `${shown} +${parts.length - 3}` : shown
}

function HistoryRow({
  session,
  templateName,
  bodyParts,
  timezone,
  onOpen
}: {
  session: GymSession
  templateName: string | null
  bodyParts: string | null
  timezone: string | null | undefined
  onOpen: () => void
}): ReactElement {
  const title = session.title || templateName || 'Gym session'
  return (
    <button type="button" className="gym-history-row" onClick={onOpen}>
      <div className="gym-history-main">
        <span className="gym-history-title">{title}</span>
        {session.workout_id !== null && <span className="gym-history-linked">synced</span>}
        {bodyParts && <span className="gym-history-bodyparts">{bodyParts}</span>}
      </div>
      <span className="gym-history-date tabular-nums">{formatDateShort(session.performed_at, timezone)}</span>
      <span className="gym-history-summary">{summarizeSession(session, templateName)}</span>
    </button>
  )
}

function HistorySection({
  sessions,
  templates,
  timezone,
  onOpen
}: {
  sessions: GymSession[]
  templates: GymTemplate[]
  timezone: string | null | undefined
  onOpen: (session: GymSession) => void
}): ReactElement {
  const templateNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of templates) m.set(t.id, t.name)
    return m
  }, [templates])

  const exercisesQuery = useExercises()
  const exercisesById = useMemo(
    () => new Map((exercisesQuery.data ?? []).map((e) => [e.id, e])),
    [exercisesQuery.data]
  )

  return (
    <section className="gym-section">
      <h2 className="gym-section-title">History</h2>
      {sessions.length === 0 ? (
        <EmptyState message="No gym logs yet — attach one to a synced session above, or create a template first." />
      ) : (
        <div className="gym-history-list">
          {sessions.map((s) => (
            <HistoryRow
              key={s.id}
              session={s}
              templateName={s.template_id ? (templateNameById.get(s.template_id) ?? null) : null}
              bodyParts={bodyPartsLabel(s, exercisesById)}
              timezone={timezone}
              onOpen={() => onOpen(s)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── templates section ────────────────────────────────────────────────────────

function templateItemsSummary(template: GymTemplate): string {
  if (template.items.length === 0) return 'No exercises yet'
  return [...template.items]
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      const sets = item.target_sets ?? '—'
      const reps = item.target_reps ?? '—'
      return `${item.exercise_name} ${sets}×${reps}`
    })
    .join(' · ')
}

function TemplateCard({
  template,
  onOpen,
  onUnarchive
}: {
  template: GymTemplate
  onOpen: () => void
  onUnarchive?: () => void
}): ReactElement {
  return (
    <div className={`gym-template-card${template.archived ? ' gym-template-card--archived' : ''}`}>
      <button type="button" className="gym-template-card-body" onClick={onOpen}>
        <span className="gym-template-name">{template.name}</span>
        <span className="gym-template-items">{templateItemsSummary(template)}</span>
        {template.notes && <span className="gym-template-notes">{template.notes}</span>}
      </button>
      {onUnarchive && (
        <button type="button" className="gym-quiet-action gym-unarchive" onClick={onUnarchive}>
          Unarchive
        </button>
      )}
    </div>
  )
}

function TemplatesSection({
  templates,
  onNew,
  onOpen
}: {
  templates: GymTemplate[]
  onNew: () => void
  onOpen: (template: GymTemplate) => void
}): ReactElement {
  const [showArchived, setShowArchived] = useState(false)
  const active = templates.filter((t) => !t.archived)
  const archived = templates.filter((t) => t.archived)
  const unarchiveMutation = useUpdateGymTemplate()

  return (
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
        <div className="gym-template-grid">
          {active.map((t) => (
            <TemplateCard key={t.id} template={t} onOpen={() => onOpen(t)} />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <>
          {!showArchived ? (
            <button type="button" className="gym-quiet-action" onClick={() => setShowArchived(true)}>
              Show archived ({archived.length})
            </button>
          ) : (
            <div className="gym-template-grid gym-template-grid--archived">
              {archived.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  onOpen={() => onOpen(t)}
                  onUnarchive={() => unarchiveMutation.mutate({ id: t.id, patch: { archived: false } })}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

// ── view ─────────────────────────────────────────────────────────────────────

export function GymView(): ReactElement {
  const userConfigQuery = useUserConfig()
  const timezone = userConfigQuery.data?.timezone

  const yearWorkoutsQuery = useYearWorkouts(timezone)

  const nowIso = useMemo(() => new Date().toISOString(), [])
  const historyFromIso = useMemo(
    () => new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString(),
    []
  )

  const gymSessionsQuery = useGymSessions(historyFromIso, nowIso)
  const templatesQuery = useGymTemplates()

  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null)
  const [templateModal, setTemplateModal] = useState<GymTemplate | null | 'new'>(null)

  const allWorkouts = yearWorkoutsQuery.data ?? []
  const gymSessions = gymSessionsQuery.data ?? []
  const templates = templatesQuery.data ?? []

  const strengthWorkouts = useMemo(
    () => allWorkouts.filter((w) => isStrengthWorkout(w.type)),
    [allWorkouts]
  )

  const linkedWorkoutIds = useMemo(() => {
    const s = new Set<string>()
    for (const session of gymSessions) {
      if (session.workout_id) s.add(session.workout_id)
    }
    return s
  }, [gymSessions])

  // Hero: strength workouts this ISO week + how many already have a log.
  const today = useMemo(() => toZonedYMD(nowIso, timezone), [nowIso, timezone])
  const thisWeekKey = isoWeekKey(today)
  const strengthThisWeek = useMemo(
    () => strengthWorkouts.filter((w) => isoWeekKey(toZonedYMD(w.start_at, timezone)) === thisWeekKey),
    [strengthWorkouts, timezone, thisWeekKey]
  )
  const loggedThisWeek = useMemo(
    () => strengthThisWeek.filter((w) => linkedWorkoutIds.has(w.id)).length,
    [strengthThisWeek, linkedWorkoutIds]
  )

  // To-log: strength workouts in the last 45 days without an attached gym_session.
  const toLogFromMs = Date.now() - TO_LOG_WINDOW_DAYS * 86_400_000
  const unloggedWorkouts = useMemo(
    () =>
      strengthWorkouts
        .filter((w) => Date.parse(w.start_at) >= toLogFromMs && !linkedWorkoutIds.has(w.id))
        .sort((a, b) => b.start_at.localeCompare(a.start_at)),
    [strengthWorkouts, toLogFromMs, linkedWorkoutIds]
  )

  const mostRecentLoggedWorkout = useMemo(() => {
    const logged = strengthWorkouts
      .filter((w) => linkedWorkoutIds.has(w.id))
      .sort((a, b) => b.start_at.localeCompare(a.start_at))
    return logged.length > 0 ? formatDateShort(logged[0].start_at, timezone) : null
  }, [strengthWorkouts, linkedWorkoutIds, timezone])

  const sortedHistory = useMemo(
    () => [...gymSessions].sort((a, b) => b.performed_at.localeCompare(a.performed_at)),
    [gymSessions]
  )

  return (
    <div className="view">
      <TabHeader eyebrow="Strength training" title="Gym" />

      <GymHero strengthWorkoutsThisWeek={strengthThisWeek} loggedThisWeek={loggedThisWeek} />

      <ToLogSection
        unloggedWorkouts={unloggedWorkouts}
        timezone={timezone}
        lastLoggedDate={mostRecentLoggedWorkout}
        onLogWorkout={(workout) => setEditorTarget({ kind: 'new-linked', workout })}
        onLogUnlinked={() => setEditorTarget({ kind: 'new-unlinked' })}
      />

      <HistorySection
        sessions={sortedHistory}
        templates={templates}
        timezone={timezone}
        onOpen={(session) => setEditorTarget({ kind: 'edit', session })}
      />

      <TemplatesSection
        templates={templates}
        onNew={() => setTemplateModal('new')}
        onOpen={(t) => setTemplateModal(t)}
      />

      {editorTarget && (
        <SessionEditorModal
          target={editorTarget}
          templates={templates}
          sessions={gymSessions}
          timezone={timezone}
          onClose={() => setEditorTarget(null)}
        />
      )}

      {templateModal !== null && (
        <TemplateEditorModal
          template={templateModal === 'new' ? null : templateModal}
          onClose={() => setTemplateModal(null)}
        />
      )}
    </div>
  )
}
