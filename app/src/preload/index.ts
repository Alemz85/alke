import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC_CHANNELS, type HealthApi } from '@shared/types'

const api: HealthApi = {
  getWorkouts: (fromIso, toIso) => ipcRenderer.invoke(IPC_CHANNELS.getWorkouts, fromIso, toIso),
  getWorkoutDetail: (id) => ipcRenderer.invoke(IPC_CHANNELS.getWorkoutDetail, id),
  getDailyMetrics: (fromDate, toDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.getDailyMetrics, fromDate, toDate),
  getComputedDaily: (fromDate, toDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.getComputedDaily, fromDate, toDate),
  getUserConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getUserConfig),
  updateUserConfig: (patch) => ipcRenderer.invoke(IPC_CHANNELS.updateUserConfig, patch),
  getTodayFlags: () => ipcRenderer.invoke(IPC_CHANNELS.getTodayFlags),
  getDbStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getDbStatus),
  getInsightCorrelations: () => ipcRenderer.invoke(IPC_CHANNELS.getInsightCorrelations),
  getInsightModels: () => ipcRenderer.invoke(IPC_CHANNELS.getInsightModels),
  chatStatus: () => ipcRenderer.invoke(IPC_CHANNELS.chatStatus),
  chatListSessions: () => ipcRenderer.invoke(IPC_CHANNELS.chatListSessions),
  chatGetSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.chatGetSession, id),
  chatSend: (sessionId: string | null, message: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatSend, sessionId, message),
  chatStop: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatStop, sessionId),
  chatRename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.chatRename, id, title),
  chatDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.chatDelete, id),
  onChatStream: (listener: (payload: never) => void) => {
    const wrapped = (_e: unknown, payload: never): void => listener(payload)
    ipcRenderer.on('chat:stream', wrapped as never)
    return () => ipcRenderer.removeListener('chat:stream', wrapped as never)
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
