import { config as loadEnv } from 'dotenv'
import { join } from 'path'

// Load app/.env before anything else touches process.env.SUPABASE_URL / SUPABASE_SERVICE_KEY.
loadEnv({ path: join(__dirname, '../../.env') })

import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC_CHANNELS } from '@shared/types'
import * as db from './db'

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
  ipcMain.handle(IPC_CHANNELS.getTodayFlags, () => db.getTodayFlags())
  ipcMain.handle(IPC_CHANNELS.getDbStatus, () => db.getDbStatus())
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
