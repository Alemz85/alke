import { ElectronAPI } from '@electron-toolkit/preload'
import type { HealthApi } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: HealthApi
  }
}
