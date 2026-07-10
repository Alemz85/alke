import { config as loadEnv } from 'dotenv'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, shell, BrowserWindow, ipcMain } from 'electron'

// Load .env before anything else touches process.env.SUPABASE_URL / SUPABASE_SERVICE_KEY.
// `app.getPath('userData')` is safe to call before app.ready(), so we can resolve the
// packaged-app credentials location without waiting for the app lifecycle.
// Candidates, in priority order:
//   1. app/.env (dev — out/main -> app, unchanged behavior)
//   2. <userData>/.env (packaged — e.g. ~/Library/Application Support/health-analytics-app/.env,
//      the documented place users drop credentials for a packaged build)
const envCandidates = [join(__dirname, '../../.env'), join(app.getPath('userData'), '.env')]
const envPath = envCandidates.find((candidate) => existsSync(candidate))
if (envPath) {
  loadEnv({ path: envPath })
  console.log(`[env] loaded credentials from ${envPath}`)
} else {
  console.log(`[env] no .env found in any candidate location: ${envCandidates.join(', ')}`)
}

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC_CHANNELS, type UserConfigPatch } from '@shared/types'
import * as db from './db'
import * as chat from './chat'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getWorkouts, (_event, fromIso: string, toIso: string) =>
    db.getWorkouts(fromIso, toIso)
  )
  ipcMain.handle(IPC_CHANNELS.getWorkoutDetail, (_event, id: string) => db.getWorkoutDetail(id))
  ipcMain.handle(IPC_CHANNELS.getDailyMetrics, (_event, fromDate: string, toDate: string) =>
    db.getDailyMetrics(fromDate, toDate)
  )
  ipcMain.handle(IPC_CHANNELS.getComputedDaily, (_event, fromDate: string, toDate: string) =>
    db.getComputedDaily(fromDate, toDate)
  )
  ipcMain.handle(IPC_CHANNELS.getUserConfig, () => db.getUserConfig())
  ipcMain.handle(IPC_CHANNELS.updateUserConfig, (_event, patch: UserConfigPatch) =>
    db.updateUserConfig(patch)
  )
  ipcMain.handle(IPC_CHANNELS.getTodayFlags, () => db.getTodayFlags())
  ipcMain.handle(IPC_CHANNELS.getDbStatus, () => db.getDbStatus())
  ipcMain.handle(IPC_CHANNELS.getInsightCorrelations, () => db.getInsightCorrelations())
  ipcMain.handle(IPC_CHANNELS.getInsightModels, () => db.getInsightModels())
  ipcMain.handle(IPC_CHANNELS.chatStatus, () => chat.checkClaude())
  ipcMain.handle(IPC_CHANNELS.chatListSessions, () => db.listChatSessions())
  ipcMain.handle(IPC_CHANNELS.chatGetSession, (_event, id: string) => db.getChatSession(id))
  ipcMain.handle(IPC_CHANNELS.chatSend, (event, sessionId: string | null, message: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('no window for chat send')
    return chat.sendMessage(win, sessionId, message)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.healthanalytics.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
