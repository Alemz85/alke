import { useMemo, type ReactElement } from 'react'
import type { GymSession } from '@shared/types'
import {
  useExercises,
  useGymSessions,
  useGymTemplates,
  useRecoveryPlanBundles
} from '../../hooks/useGymData'
import { buildRecoveryLogTemplate } from '../../lib/recoveryLogTemplates'
import { SessionEditorModal, type EditorTarget } from './SessionEditorModal'

const HISTORY_WINDOW_DAYS = 90

/**
 * Query-owning modal host shared by every DayDetailDrawer. It mounts only once
 * a logging action is selected, so ordinary drawer reads retain their light
 * query footprint while the editor gets the same 90-day context as Gym.
 */
export function GymSessionEditorHost({
  target,
  timezone,
  onClose
}: {
  target: EditorTarget
  timezone: string | null | undefined
  onClose: () => void
}): ReactElement {
  const nowIso = useMemo(() => new Date().toISOString(), [])
  const historyFromIso = useMemo(
    () => new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString(),
    []
  )
  const sessionsQuery = useGymSessions(historyFromIso, nowIso)
  const templatesQuery = useGymTemplates()
  const exercisesQuery = useExercises()
  const recoveryPlanBundlesQuery = useRecoveryPlanBundles()
  const exercisesById = useMemo(
    () => new Map((exercisesQuery.data ?? []).map((exercise) => [exercise.id, exercise])),
    [exercisesQuery.data]
  )
  const recoveryTemplates = useMemo(
    () =>
      recoveryPlanBundlesQuery.data.map(({ injury, items }) =>
        buildRecoveryLogTemplate(injury, items, exercisesById)
      ),
    [recoveryPlanBundlesQuery.data, exercisesById]
  )

  return (
    <SessionEditorModal
      target={target}
      templates={templatesQuery.data ?? []}
      recoveryTemplates={recoveryTemplates}
      sessions={(sessionsQuery.data ?? []) as GymSession[]}
      timezone={timezone}
      onClose={onClose}
    />
  )
}
