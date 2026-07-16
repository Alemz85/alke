import type {
  GoalPatch,
  GymBodyPart,
  GymSessionPatch,
  GymTemplatePatch,
  Injury,
  NewGoal,
  NewGymSession,
  NewGymTemplate,
  NewInjuryLog,
  UserConfigPatch
} from '@shared/types'
import type { QueuedWriteOperation } from './offlineQueue'

export type OfflineWriteType =
  | 'addInjuryLog'
  | 'deleteInjuryLog'
  | 'updateInjuryStatus'
  | 'deleteInjury'
  | 'updateInjuryPlanStart'
  | 'updateInjuryStartedAt'
  | 'setPlanItemCheck'
  | 'addGymTemplate'
  | 'updateGymTemplate'
  | 'deleteGymTemplate'
  | 'createGymTemplateVersion'
  | 'startGymTemplateRun'
  | 'completeGymTemplateRun'
  | 'addGymSession'
  | 'updateGymSession'
  | 'deleteGymSession'
  | 'addProtein'
  | 'setProtein'
  | 'addGoal'
  | 'updateGoal'
  | 'deleteGoal'
  | 'addExercise'
  | 'updateUserConfig'

export interface OfflineWriteDatabase {
  addInjuryLog(entry: NewInjuryLog, mutationId: string): Promise<unknown>
  deleteInjuryLog(id: number): Promise<unknown>
  updateInjuryStatus(injuryId: string, status: Injury['status']): Promise<unknown>
  deleteInjury(id: string): Promise<unknown>
  updateInjuryPlanStart(injuryId: string, planStartedAt: string): Promise<unknown>
  updateInjuryStartedAt(injuryId: string, startedAt: string): Promise<unknown>
  setPlanItemCheck(itemId: string, doneDate: string, done: boolean): Promise<unknown>
  addGymTemplate(template: NewGymTemplate, mutationId: string): Promise<unknown>
  updateGymTemplate(id: string, patch: GymTemplatePatch): Promise<unknown>
  deleteGymTemplate(id: string): Promise<unknown>
  createGymTemplateVersion(
    baseTemplateId: string,
    template: NewGymTemplate,
    mutationId: string
  ): Promise<unknown>
  startGymTemplateRun(templateId: string): Promise<unknown>
  completeGymTemplateRun(templateId: string): Promise<unknown>
  addGymSession(session: NewGymSession, mutationId: string): Promise<unknown>
  updateGymSession(id: string, patch: GymSessionPatch): Promise<unknown>
  deleteGymSession(id: string): Promise<unknown>
  addProtein(date: string, grams: number, mutationId: string): Promise<unknown>
  setProtein(date: string, grams: number): Promise<unknown>
  addGoal(goal: NewGoal, mutationId: string): Promise<unknown>
  updateGoal(id: string, patch: GoalPatch): Promise<unknown>
  deleteGoal(id: string): Promise<unknown>
  // Idempotent by name already (exercises.name_key is unique — a retried add
  // with the same name resolves to the existing row), so no mutationId param.
  addExercise(name: string, bodyPart: GymBodyPart | null): Promise<unknown>
  updateUserConfig(patch: UserConfigPatch): Promise<unknown>
}

/** Execute a serialized write using its stable queue operation id. */
export async function executeOfflineWrite(
  db: OfflineWriteDatabase,
  operation: QueuedWriteOperation
): Promise<unknown> {
  const [first, second, third] = operation.args
  switch (operation.type as OfflineWriteType) {
    case 'addInjuryLog':
      return db.addInjuryLog(first as NewInjuryLog, operation.id)
    case 'deleteInjuryLog':
      return db.deleteInjuryLog(first as number)
    case 'updateInjuryStatus':
      return db.updateInjuryStatus(first as string, second as Injury['status'])
    case 'deleteInjury':
      return db.deleteInjury(first as string)
    case 'updateInjuryPlanStart':
      return db.updateInjuryPlanStart(first as string, second as string)
    case 'updateInjuryStartedAt':
      return db.updateInjuryStartedAt(first as string, second as string)
    case 'setPlanItemCheck':
      return db.setPlanItemCheck(first as string, second as string, third as boolean)
    case 'addGymTemplate':
      return db.addGymTemplate(first as NewGymTemplate, operation.id)
    case 'updateGymTemplate':
      return db.updateGymTemplate(first as string, second as GymTemplatePatch)
    case 'deleteGymTemplate':
      return db.deleteGymTemplate(first as string)
    case 'createGymTemplateVersion':
      return db.createGymTemplateVersion(first as string, second as NewGymTemplate, operation.id)
    case 'startGymTemplateRun':
      return db.startGymTemplateRun(first as string)
    case 'completeGymTemplateRun':
      return db.completeGymTemplateRun(first as string)
    case 'addGymSession':
      return db.addGymSession(first as NewGymSession, operation.id)
    case 'updateGymSession':
      return db.updateGymSession(first as string, second as GymSessionPatch)
    case 'deleteGymSession':
      return db.deleteGymSession(first as string)
    case 'addProtein':
      return db.addProtein(first as string, second as number, operation.id)
    case 'setProtein':
      return db.setProtein(first as string, second as number)
    case 'addGoal':
      return db.addGoal(first as NewGoal, operation.id)
    case 'updateGoal':
      return db.updateGoal(first as string, second as GoalPatch)
    case 'deleteGoal':
      return db.deleteGoal(first as string)
    case 'addExercise':
      return db.addExercise(first as string, second as GymBodyPart | null)
    case 'updateUserConfig':
      return db.updateUserConfig(first as UserConfigPatch)
    default:
      throw new Error(`unsupported offline write type: ${operation.type}`)
  }
}
