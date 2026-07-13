// Data hooks for the Gym tab, following useSessionsData.ts conventions:
// view-neutral 'health'-prefixed query keys so cache entries are shared by
// construction, sensible staleTime, and mutations that invalidate the
// ['health', 'gym'] family (plus ['health', 'exercises'] after a catalog add).
import { useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type {
  Exercise,
  GymBodyPart,
  GymSession,
  GymSessionPatch,
  GymTemplate,
  GymTemplatePatch,
  Injury,
  NewGymSession,
  NewGymTemplate,
  RecoveryPlanItem
} from '@shared/types'
import {
  applyOptimisticSessionPatch,
  applyOptimisticTemplatePatch,
  makeOptimisticSession,
  makeOptimisticTemplate
} from '../lib/optimisticGym'
import {
  isQueuedWriteReceipt,
  removeById,
  replaceById,
  sessionFallsWithinQuery
} from '../lib/optimisticEntities'

type QuerySnapshot = [QueryKey, unknown]

function restoreSnapshots(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshots: QuerySnapshot[] | undefined
): void {
  for (const [queryKey, data] of snapshots ?? []) queryClient.setQueryData(queryKey, data)
}

function cachedExercises(queryClient: ReturnType<typeof useQueryClient>): Exercise[] {
  return queryClient.getQueryData<Exercise[]>(['health', 'exercises']) ?? []
}

export interface RecoveryPlanBundle {
  injury: Injury
  items: RecoveryPlanItem[]
}

/** Active injury plans, shared by the Templates tab and the Gym logger. */
export function useRecoveryPlanBundles(): {
  data: RecoveryPlanBundle[]
  isLoading: boolean
  isError: boolean
} {
  const injuriesQuery = useQuery<Injury[]>({
    queryKey: ['health', 'injuries'],
    queryFn: () => window.api.getInjuries(),
    staleTime: 60_000
  })
  const injuries = (injuriesQuery.data ?? []).filter((injury) => injury.status !== 'resolved')
  const planQueries = useQueries({
    queries: injuries.map((injury) => ({
      queryKey: ['health', 'injuryPlan', injury.id],
      queryFn: () => window.api.getInjuryPlan(injury.id),
      staleTime: 60_000
    }))
  })

  return {
    data: injuries.map((injury, index) => ({
      injury,
      items: (planQueries[index]?.data ?? []) as RecoveryPlanItem[]
    })),
    isLoading: injuriesQuery.isLoading || planQueries.some((query) => query.isLoading),
    isError: injuriesQuery.isError || planQueries.some((query) => query.isError)
  }
}

export function useExercises() {
  return useQuery<Exercise[]>({
    queryKey: ['health', 'exercises'],
    queryFn: () => window.api.getExercises(),
    staleTime: 60_000
  })
}

export function useAddExercise() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, bodyPart }: { name: string; bodyPart: GymBodyPart | null }) =>
      window.api.addExercise(name, bodyPart),
    meta: { errorMessage: 'Couldn’t create the exercise. Your typed name is still available.' },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'exercises'] })
    }
  })
}

export function useGymTemplates() {
  return useQuery<GymTemplate[]>({
    queryKey: ['health', 'gym', 'templates'],
    queryFn: () => window.api.getGymTemplates(),
    staleTime: 60_000
  })
}

export function useAddGymTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (template: NewGymTemplate) => window.api.addGymTemplate(template),
    scope: { id: 'gym-templates' },
    meta: { errorMessage: 'Couldn’t create the template. It was removed from the list.' },
    onMutate: async (template) => {
      const queryKey = ['health', 'gym', 'templates'] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<GymTemplate[]>({ queryKey }) as QuerySnapshot[]
      const temporaryId = `optimistic:${crypto.randomUUID()}`
      const temporary = makeOptimisticTemplate(template, cachedExercises(queryClient), temporaryId)
      queryClient.setQueryData<GymTemplate[]>(queryKey, (rows = []) => [temporary, ...rows])
      return { previous, temporaryId }
    },
    onSuccess: (result, _template, context) => {
      if (isQueuedWriteReceipt(result)) return
      queryClient.setQueryData<GymTemplate[]>(['health', 'gym', 'templates'], (rows = []) =>
        replaceById(rows, context.temporaryId, result)
      )
    },
    onError: (_error, _template, context) => restoreSnapshots(queryClient, context?.previous)
  })
}

export function useUpdateGymTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: GymTemplatePatch }) =>
      window.api.updateGymTemplate(id, patch),
    scope: { id: 'gym-templates' },
    meta: { errorMessage: 'Couldn’t update the template. Your previous version was restored.' },
    onMutate: async ({ id, patch }) => {
      const queryKey = ['health', 'gym', 'templates'] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<GymTemplate[]>({ queryKey }) as QuerySnapshot[]
      const exercises = cachedExercises(queryClient)
      queryClient.setQueryData<GymTemplate[]>(queryKey, (rows = []) =>
        rows.map((template) =>
          template.id === id ? applyOptimisticTemplatePatch(template, patch, exercises) : template
        )
      )
      return { previous }
    },
    onSuccess: (result, { id }) => {
      if (isQueuedWriteReceipt(result)) return
      queryClient.setQueryData<GymTemplate[]>(['health', 'gym', 'templates'], (rows = []) =>
        replaceById(rows, id, result)
      )
    },
    onError: (_error, _variables, context) => restoreSnapshots(queryClient, context?.previous)
  })
}

export function useDeleteGymTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.deleteGymTemplate(id),
    scope: { id: 'gym-templates' },
    meta: { errorMessage: 'Couldn’t delete the template. It has been put back.' },
    onMutate: async (id) => {
      const queryKey = ['health', 'gym', 'templates'] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<GymTemplate[]>({ queryKey }) as QuerySnapshot[]
      queryClient.setQueryData<GymTemplate[]>(queryKey, (rows = []) => removeById(rows, id))
      return { previous }
    },
    onError: (_error, _id, context) => restoreSnapshots(queryClient, context?.previous)
  })
}

/** All versions of a template family (ascending by version), for the version dropdown. */
export function useGymTemplateVersions(familyId: string | null | undefined) {
  return useQuery<GymTemplate[]>({
    queryKey: ['health', 'gym', 'templateVersions', familyId],
    queryFn: () => window.api.getGymTemplateVersions(familyId as string),
    enabled: familyId != null,
    staleTime: 60_000
  })
}

/** Saves an edited template as the next version of its family (previous versions demoted). */
export function useCreateGymTemplateVersion() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ baseTemplateId, template }: { baseTemplateId: string; template: NewGymTemplate }) =>
      window.api.createGymTemplateVersion(baseTemplateId, template),
    meta: { errorMessage: 'Couldn’t save the new version.' },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templates'] })
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templateVersions'] })
    }
  })
}

/** Activates/resurrects a template — opens a run (idempotent if already active). */
export function useStartGymTemplateRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (templateId: string) => window.api.startGymTemplateRun(templateId),
    meta: { errorMessage: 'Couldn’t start the template.' },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templates'] })
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templateVersions'] })
    }
  })
}

/** Marks a template's active run complete (closes the family's open run). */
export function useCompleteGymTemplateRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (templateId: string) => window.api.completeGymTemplateRun(templateId),
    meta: { errorMessage: 'Couldn’t mark the template complete.' },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templates'] })
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templateVersions'] })
    }
  })
}

/** Logged gym sessions for [fromIso, toIso], already sorted desc by the main process. */
export function useGymSessions(fromIso: string, toIso: string) {
  return useQuery<GymSession[]>({
    queryKey: ['health', 'gym', 'sessions', fromIso, toIso],
    queryFn: () => window.api.getGymSessions(fromIso, toIso),
    staleTime: 60_000
  })
}

export function useAddGymSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (session: NewGymSession) => window.api.addGymSession(session),
    scope: { id: 'gym-sessions' },
    meta: { errorMessage: 'Couldn’t save the session. It was removed from the log.' },
    onMutate: async (session) => {
      const queryKey = ['health', 'gym', 'sessions'] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<GymSession[]>({ queryKey }) as QuerySnapshot[]
      const temporaryId = `optimistic:${crypto.randomUUID()}`
      const temporary = makeOptimisticSession(
        session,
        cachedExercises(queryClient),
        temporaryId,
        session.performed_at ?? new Date().toISOString()
      )
      for (const [rangeKey, rows] of previous as Array<[QueryKey, GymSession[] | undefined]>) {
        if (sessionFallsWithinQuery(rangeKey, temporary)) {
          queryClient.setQueryData<GymSession[]>(rangeKey, [temporary, ...(rows ?? [])])
        }
      }
      return { previous, temporaryId }
    },
    onSuccess: (result, _session, context) => {
      if (isQueuedWriteReceipt(result)) return
      for (const [rangeKey, rows] of queryClient.getQueriesData<GymSession[]>({ queryKey: ['health', 'gym', 'sessions'] })) {
        queryClient.setQueryData(rangeKey, replaceById(rows ?? [], context.temporaryId, result))
      }
    },
    onError: (_error, _session, context) => restoreSnapshots(queryClient, context?.previous)
  })
}

export function useUpdateGymSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: GymSessionPatch }) =>
      window.api.updateGymSession(id, patch),
    scope: { id: 'gym-sessions' },
    meta: { errorMessage: 'Couldn’t update the session. Your previous version was restored.' },
    onMutate: async ({ id, patch }) => {
      const queryKey = ['health', 'gym', 'sessions'] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<GymSession[]>({ queryKey }) as QuerySnapshot[]
      const exercises = cachedExercises(queryClient)
      for (const [rangeKey, rows] of previous as Array<[QueryKey, GymSession[] | undefined]>) {
        queryClient.setQueryData<GymSession[]>(rangeKey, (rows ?? []).map((session) =>
          session.id === id ? applyOptimisticSessionPatch(session, patch, exercises) : session
        ))
      }
      return { previous }
    },
    onSuccess: (result, { id }) => {
      if (isQueuedWriteReceipt(result)) return
      for (const [rangeKey, rows] of queryClient.getQueriesData<GymSession[]>({ queryKey: ['health', 'gym', 'sessions'] })) {
        queryClient.setQueryData(rangeKey, replaceById(rows ?? [], id, result))
      }
    },
    onError: (_error, _variables, context) => restoreSnapshots(queryClient, context?.previous)
  })
}

export function useDeleteGymSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.deleteGymSession(id),
    scope: { id: 'gym-sessions' },
    meta: { errorMessage: 'Couldn’t delete the session. It has been put back.' },
    onMutate: async (id) => {
      const queryKey = ['health', 'gym', 'sessions'] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<GymSession[]>({ queryKey }) as QuerySnapshot[]
      for (const [rangeKey, rows] of previous as Array<[QueryKey, GymSession[] | undefined]>) {
        queryClient.setQueryData<GymSession[]>(rangeKey, removeById(rows ?? [], id))
      }
      return { previous }
    },
    onError: (_error, _id, context) => restoreSnapshots(queryClient, context?.previous)
  })
}
