import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC_CHANNELS, type HealthApi } from '@shared/types'

const api: HealthApi = {
  getWorkouts: (fromIso, toIso) => ipcRenderer.invoke(IPC_CHANNELS.getWorkouts, fromIso, toIso),
  getWorkoutDetail: (id) => ipcRenderer.invoke(IPC_CHANNELS.getWorkoutDetail, id),
  getSwimSets: (fromIso, toIso) => ipcRenderer.invoke(IPC_CHANNELS.getSwimSets, fromIso, toIso),
  getDailyMetrics: (fromDate, toDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.getDailyMetrics, fromDate, toDate),
  getComputedDaily: (fromDate, toDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.getComputedDaily, fromDate, toDate),
  getZone2Fitness: (fromDate, toDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.getZone2Fitness, fromDate, toDate),
  getProteinLog: (fromDate, toDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.getProteinLog, fromDate, toDate),
  addProtein: (date, grams) => ipcRenderer.invoke(IPC_CHANNELS.addProtein, date, grams),
  setProtein: (date, grams) => ipcRenderer.invoke(IPC_CHANNELS.setProtein, date, grams),
  getOfflineQueueStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getOfflineQueueStatus),
  retryOfflineQueue: () => ipcRenderer.invoke(IPC_CHANNELS.retryOfflineQueue),
  onOfflineQueueStatus: (listener) => {
    const wrapped = (_event: unknown, status: Parameters<typeof listener>[0]): void => listener(status)
    ipcRenderer.on(IPC_CHANNELS.offlineQueueStatus, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.offlineQueueStatus, wrapped)
  },
  getUserConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getUserConfig),
  updateUserConfig: (patch) => ipcRenderer.invoke(IPC_CHANNELS.updateUserConfig, patch),
  getTodayFlags: () => ipcRenderer.invoke(IPC_CHANNELS.getTodayFlags),
  getInjuries: () => ipcRenderer.invoke(IPC_CHANNELS.getInjuries),
  getInjuryLog: (injuryId) => ipcRenderer.invoke(IPC_CHANNELS.getInjuryLog, injuryId),
  addInjuryLog: (entry) => ipcRenderer.invoke(IPC_CHANNELS.addInjuryLog, entry),
  deleteInjuryLog: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteInjuryLog, id),
  updateInjuryStatus: (injuryId, status) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateInjuryStatus, injuryId, status),
  getInjuryPlan: (injuryId) => ipcRenderer.invoke(IPC_CHANNELS.getInjuryPlan, injuryId),
  updateInjuryPlanStart: (injuryId, planStartedAt) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateInjuryPlanStart, injuryId, planStartedAt),
  updateInjuryStartedAt: (injuryId, startedAt) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateInjuryStartedAt, injuryId, startedAt),
  deleteInjury: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteInjury, id),
  getInjuryPlanChecks: (injuryId, fromDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.getInjuryPlanChecks, injuryId, fromDate),
  setPlanItemCheck: (itemId, doneDate, done) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPlanItemCheck, itemId, doneDate, done),
  getExercises: () => ipcRenderer.invoke(IPC_CHANNELS.getExercises),
  addExercise: (name, bodyPart) => ipcRenderer.invoke(IPC_CHANNELS.addExercise, name, bodyPart),
  getGymTemplates: () => ipcRenderer.invoke(IPC_CHANNELS.getGymTemplates),
  addGymTemplate: (template) => ipcRenderer.invoke(IPC_CHANNELS.addGymTemplate, template),
  updateGymTemplate: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.updateGymTemplate, id, patch),
  deleteGymTemplate: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteGymTemplate, id),
  createGymTemplateVersion: (baseTemplateId, template) =>
    ipcRenderer.invoke(IPC_CHANNELS.createGymTemplateVersion, baseTemplateId, template),
  getGymTemplateVersions: (familyId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getGymTemplateVersions, familyId),
  startGymTemplateRun: (templateId) =>
    ipcRenderer.invoke(IPC_CHANNELS.startGymTemplateRun, templateId),
  completeGymTemplateRun: (templateId) =>
    ipcRenderer.invoke(IPC_CHANNELS.completeGymTemplateRun, templateId),
  getGymSessions: (fromIso, toIso) =>
    ipcRenderer.invoke(IPC_CHANNELS.getGymSessions, fromIso, toIso),
  addGymSession: (session) => ipcRenderer.invoke(IPC_CHANNELS.addGymSession, session),
  updateGymSession: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.updateGymSession, id, patch),
  deleteGymSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteGymSession, id),
  getGoals: () => ipcRenderer.invoke(IPC_CHANNELS.getGoals),
  getGoalProgress: (goalId) => ipcRenderer.invoke(IPC_CHANNELS.getGoalProgress, goalId),
  addGoal: (goal) => ipcRenderer.invoke(IPC_CHANNELS.addGoal, goal),
  updateGoal: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.updateGoal, id, patch),
  deleteGoal: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteGoal, id),
  buildGoalMetric: (goalId) => ipcRenderer.invoke(IPC_CHANNELS.buildGoalMetric, goalId),
  getDbStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getDbStatus),
  getLastIngestAt: () => ipcRenderer.invoke(IPC_CHANNELS.getLastIngestAt),
  getInsightCorrelations: () => ipcRenderer.invoke(IPC_CHANNELS.getInsightCorrelations),
  getInsightModels: () => ipcRenderer.invoke(IPC_CHANNELS.getInsightModels),
  runMetricsJob: () => ipcRenderer.invoke(IPC_CHANNELS.runMetricsJob),
  chatStatus: () => ipcRenderer.invoke(IPC_CHANNELS.chatStatus),
  chatListSessions: () => ipcRenderer.invoke(IPC_CHANNELS.chatListSessions),
  chatGetSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.chatGetSession, id),
  chatGetRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.chatGetRuntime),
  chatPickAttachments: () => ipcRenderer.invoke(IPC_CHANNELS.chatPickAttachments),
  chatValidateAttachments: (paths) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatValidateAttachments, paths),
  // Synchronous local resolution — dropped File objects no longer expose `.path`
  // in Electron, so the renderer asks the preload for it via webUtils.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  chatSend: (sessionId, message, attachmentPaths = [], mode) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatSend, sessionId, message, attachmentPaths, mode),
  chatContinue: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatContinue, sessionId),
  chatStop: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatStop, sessionId),
  chatRename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.chatRename, id, title),
  chatDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.chatDelete, id),
  onChatStream: (listener) => {
    const wrapped = (_e: unknown, payload: Parameters<typeof listener>[0]): void => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.chatStream, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatStream, wrapped)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
