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
  getTodayFlags: () => ipcRenderer.invoke(IPC_CHANNELS.getTodayFlags),
  getDbStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getDbStatus)
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
