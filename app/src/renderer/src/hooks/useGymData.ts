// Data hooks for the Gym tab, following useSessionsData.ts conventions:
// view-neutral 'health'-prefixed query keys so cache entries are shared by
// construction, sensible staleTime, and mutations that invalidate the
// ['health', 'gym'] family (plus ['health', 'exercises'] after a catalog add).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Exercise,
  GymBodyPart,
  GymSession,
  GymSessionPatch,
  GymTemplate,
  GymTemplatePatch,
  NewGymSession,
  NewGymTemplate
} from '@shared/types'

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templates'] })
    }
  })
}

export function useUpdateGymTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: GymTemplatePatch }) =>
      window.api.updateGymTemplate(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym', 'templates'] })
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym'] })
    }
  })
}

export function useUpdateGymSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: GymSessionPatch }) =>
      window.api.updateGymSession(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym'] })
    }
  })
}

export function useDeleteGymSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.deleteGymSession(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health', 'gym'] })
    }
  })
}
