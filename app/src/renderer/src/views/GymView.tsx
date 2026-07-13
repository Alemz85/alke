import { useMemo, useState, type ReactElement } from 'react'
import type { GymSession, GymTemplate } from '@shared/types'
import { DayDetailDrawer } from '../components/DayDetailDrawer'
import { TabHeader } from './TabHeader'
import { useDailyMetricsRange, useUserConfig, useYearWorkouts } from '../hooks/useSessionsData'
import {
  useExercises,
  useGymSessions,
  useGymTemplates,
  useRecoveryPlanBundles
} from '../hooks/useGymData'
import { addDays, toZonedYMD, ymdKey } from '../hooks/sessionsDate'
import { isStrengthWorkout } from '../lib/gymLog'
import { computeMuscleFatigue } from '../lib/muscleFatigue'
import { computeStrengthLevels } from '../lib/strengthLevel'
import { buildRecoveryLogTemplate } from '../lib/recoveryLogTemplates'
import { SessionEditorModal, type EditorTarget } from './gym/SessionEditorModal'
import { TemplateEditorModal } from './gym/TemplateEditorModal'
import { GymMainTab } from './gym/GymMainTab'
import { GymTemplatesTab } from './gym/GymTemplatesTab'
import { GymSessionsTab } from './gym/GymSessionsTab'
import { GymWorkoutPanel } from './gym/GymWorkoutPanel'
import type { GymSessionItem } from './gym/gymSessionItem'
import { formatDateShort } from './gym/gymFormat'
import { TemplateViewModal } from './gym/TemplateViewModal'
import './GymView.css'

const HISTORY_WINDOW_DAYS = 90
const GYM_HISTORY_START_ISO = '2000-01-01T00:00:00.000Z'

type SubTab = 'main' | 'templates' | 'sessions'

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'main', label: 'Main' },
  { id: 'templates', label: 'Templates' },
  { id: 'sessions', label: 'Sessions' }
]

/**
 * Gym section shell. Owns the shared queries + modal state and routes between
 * the Main / Templates / Sessions sub-tabs (the same tablist pattern as Cardio).
 */
export function GymView(): ReactElement {
  const userConfigQuery = useUserConfig()
  const timezone = userConfigQuery.data?.timezone

  const yearWorkoutsQuery = useYearWorkouts(timezone)
  const nowIso = useMemo(() => new Date().toISOString(), [])
  const today = useMemo(() => toZonedYMD(nowIso, timezone), [nowIso, timezone])
  const historyFromIso = useMemo(
    () => new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString(),
    []
  )
  const gymSessionsQuery = useGymSessions(historyFromIso, nowIso)
  // Strength peaks and template completion are lifetime records, not a
  // 90-day snapshot. Personal data volume is small enough for this direct
  // history read; the fatigue model below deliberately stays windowed.
  const gymHistoryQuery = useGymSessions(GYM_HISTORY_START_ISO, nowIso)
  const bodyWeightQuery = useDailyMetricsRange(ymdKey(addDays(today, -365)), ymdKey(today))
  const templatesQuery = useGymTemplates()
  const exercisesQuery = useExercises()
  const recoveryPlanBundlesQuery = useRecoveryPlanBundles()

  const [subTab, setSubTab] = useState<SubTab>('main')
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null)
  const [templateModal, setTemplateModal] = useState<GymTemplate | null | 'new'>(null)
  const [templateView, setTemplateView] = useState<GymTemplate | null>(null)
  const [selectedGymItemKey, setSelectedGymItemKey] = useState<string | null>(null)
  const [recoveryDraftTemplateId, setRecoveryDraftTemplateId] = useState<string | null>(null)

  const allWorkouts = yearWorkoutsQuery.data ?? []
  const gymSessions = gymSessionsQuery.data ?? []
  const allGymSessions = gymHistoryQuery.data ?? gymSessions
  const templates = templatesQuery.data ?? []

  const exercisesById = useMemo(
    () => new Map((exercisesQuery.data ?? []).map((e) => [e.id, e])),
    [exercisesQuery.data]
  )
  const templateNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of templates) m.set(t.id, t.name)
    return m
  }, [templates])
  const recoveryTemplates = useMemo(
    () =>
      recoveryPlanBundlesQuery.data.map(({ injury, items }) =>
        buildRecoveryLogTemplate(injury, items, exercisesById)
      ),
    [recoveryPlanBundlesQuery.data, exercisesById]
  )
  // "Done N×" per template — lifetime usage from every logged gym session.
  const templateUsageById = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of allGymSessions) {
      for (const templateId of s.template_ids) {
        m.set(templateId, (m.get(templateId) ?? 0) + 1)
      }
    }
    return m
  }, [allGymSessions])

  const bodyWeightKg = useMemo(() => {
    const readings = (bodyWeightQuery.data ?? [])
      .filter((metric): metric is typeof metric & { weight_kg: number } => typeof metric.weight_kg === 'number')
      .sort((a, b) => b.date.localeCompare(a.date))
    return readings[0]?.weight_kg ?? null
  }, [bodyWeightQuery.data])

  const strengthWorkouts = useMemo(
    () => allWorkouts.filter((w) => isStrengthWorkout(w.type)),
    [allWorkouts]
  )
  const sortedHistory = useMemo(
    () => [...gymSessions].sort((a, b) => b.performed_at.localeCompare(a.performed_at)),
    [gymSessions]
  )

  // Unified gym-only session list: each strength workout (logged or not) + each
  // standalone log, newest first.
  const gymSessionItems = useMemo<GymSessionItem[]>(() => {
    const sessionByWorkout = new Map<string, GymSession>()
    const standalone: GymSession[] = []
    for (const s of gymSessions) {
      if (s.workout_id) sessionByWorkout.set(s.workout_id, s)
      else standalone.push(s)
    }
    const out: GymSessionItem[] = []
    for (const w of strengthWorkouts) {
      const s = sessionByWorkout.get(w.id) ?? null
      out.push({ key: w.id, workout: w, session: s, dateIso: w.start_at, logged: s != null })
    }
    for (const s of standalone) {
      out.push({ key: s.id, workout: null, session: s, dateIso: s.performed_at, logged: true })
    }
    return out.sort((a, b) => b.dateIso.localeCompare(a.dateIso))
  }, [strengthWorkouts, gymSessions])
  const selectedGymItem = useMemo(
    () =>
      selectedGymItemKey
        ? gymSessionItems.find((item) => item.key === selectedGymItemKey) ?? null
        : null,
    [gymSessionItems, selectedGymItemKey]
  )
  const recoveryDraftItem = useMemo<GymSessionItem | null>(
    () =>
      recoveryDraftTemplateId
        ? {
            key: `draft:${recoveryDraftTemplateId}`,
            workout: null,
            session: null,
            dateIso: nowIso,
            logged: false
          }
        : null,
    [recoveryDraftTemplateId, nowIso]
  )
  const workoutViewerItem = selectedGymItem ?? recoveryDraftItem

  const openSession = (session: GymSession): void => {
    setRecoveryDraftTemplateId(null)
    setSelectedGymItemKey(session.workout_id ?? session.id)
  }

  const closeWorkoutViewer = (): void => {
    setSelectedGymItemKey(null)
    setRecoveryDraftTemplateId(null)
  }

  const muscleFatigue = useMemo(
    () =>
      computeMuscleFatigue({
        sessions: gymSessions,
        workouts: allWorkouts,
        exercisesById,
        aerobicBase: null, // TODO: wire the Zone-2 durable base for recovery modulation
        timezone: timezone ?? null,
        asOf: new Date()
      }),
    [gymSessions, allWorkouts, exercisesById, timezone]
  )

  const strengthLevels = useMemo(
    () =>
      computeStrengthLevels({
        sessions: allGymSessions,
        exercisesById,
        timezone: timezone ?? null,
        asOf: new Date(),
        bodyWeightKg
      }),
    [allGymSessions, exercisesById, timezone, bodyWeightKg]
  )

  return (
    <div className="view">
      <TabHeader eyebrow="Strength training" title="Gym" />

      <div className="gym-tabs" role="tablist" aria-label="Gym section">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={subTab === t.id}
            className={subTab === t.id ? 'gym-tab gym-tab--active' : 'gym-tab'}
            onClick={() => {
              setSelectedGymItemKey(null)
              setRecoveryDraftTemplateId(null)
              setSubTab(t.id)
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'main' && (
        <GymMainTab
          muscleFatigue={muscleFatigue}
          strengthLevels={strengthLevels}
          recentSessions={sortedHistory}
          templateNameById={templateNameById}
          today={today}
          timezone={timezone}
          onOpenSession={openSession}
          onOpenSessionsTab={() => setSubTab('sessions')}
        />
      )}

      {subTab === 'templates' && (
        <GymTemplatesTab
          templates={templates}
          recoveryTemplates={recoveryTemplates}
          usageById={templateUsageById}
          onView={(t) => setTemplateView(t)}
          onNew={() => setTemplateModal('new')}
          onUseRecovery={(template) => {
            setSelectedGymItemKey(null)
            setRecoveryDraftTemplateId(template.id)
          }}
        />
      )}

      {subTab === 'sessions' && (
        <GymSessionsTab
          items={gymSessionItems}
          exercisesById={exercisesById}
          templateNameById={templateNameById}
          timezone={timezone}
          onOpenItem={(item) => {
            setRecoveryDraftTemplateId(null)
            setSelectedGymItemKey(item.key)
          }}
          onLogUnlinked={() => setEditorTarget({ kind: 'new-unlinked' })}
        />
      )}

      {editorTarget && (
        <SessionEditorModal
          target={editorTarget}
          templates={templates}
          recoveryTemplates={recoveryTemplates}
          sessions={gymSessions}
          timezone={timezone}
          onClose={() => setEditorTarget(null)}
        />
      )}

      {workoutViewerItem && (
        <DayDetailDrawer
          dateLabel={
            recoveryDraftTemplateId
              ? 'New recovery log'
              : formatDateShort(workoutViewerItem.dateIso, timezone)
          }
          workouts={workoutViewerItem.workout ? [workoutViewerItem.workout] : []}
          timezone={timezone}
          onClose={closeWorkoutViewer}
        >
          <GymWorkoutPanel
            key={`${workoutViewerItem.key}:${workoutViewerItem.session?.id ?? 'unlogged'}`}
            item={workoutViewerItem}
            templates={templates}
            recoveryTemplates={recoveryTemplates}
            sessions={gymSessions}
            exercisesById={exercisesById}
            templateNameById={templateNameById}
            timezone={timezone}
            onClose={closeWorkoutViewer}
            initialRecoveryTemplateId={recoveryDraftTemplateId ?? undefined}
          />
        </DayDetailDrawer>
      )}

      {templateView && (
        <TemplateViewModal
          template={templateView}
          usageCount={templateUsageById.get(templateView.id) ?? 0}
          onEdit={() => {
            const t = templateView
            setTemplateView(null)
            setTemplateModal(t)
          }}
          onClose={() => setTemplateView(null)}
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
