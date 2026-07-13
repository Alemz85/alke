import { config as loadEnv } from 'dotenv'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, shell, screen, BrowserWindow, ipcMain } from 'electron'

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
import {
  IPC_CHANNELS,
  type UserConfigPatch,
  type Flag,
  type GoalPatch,
  type GymBodyPart,
  type GymSessionPatch,
  type GymTemplatePatch,
  type Injury,
  type NewGoal,
  type NewGymSession,
  type NewGymTemplate,
  type NewInjuryLog
} from '@shared/types'
import * as db from './db'
import * as chat from './chat'
import { executeOfflineWrite } from './offlineWriteHandlers'
import { OfflineWriteService } from './offlineWriteService'
import { registerTileScheme, setupTileProtocol } from './tiles'

// Privileged-scheme registration must happen before app.whenReady().
registerTileScheme()

const offlineWrites = new OfflineWriteService(
  join(app.getPath('userData'), 'offline-write-queue.json'),
  (operation) => executeOfflineWrite(db, operation),
  (status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.offlineQueueStatus, status)
    }
  },
  randomUUID
)

// HEALTH_APP_DISPLAY=external places the window on a non-primary display
// (used by automated test launches so they stay off the main monitor).
function externalDisplayBounds(): { x: number; y: number } | null {
  if (process.env.HEALTH_APP_DISPLAY !== 'external') return null
  const primary = screen.getPrimaryDisplay()
  const external = screen.getAllDisplays().find((d) => d.id !== primary.id)
  if (!external) return null
  const { x, y, width, height } = external.workArea
  return { x: x + Math.max(0, (width - 1440) / 2), y: y + Math.max(0, (height - 900) / 2) }
}

function createWindow(): void {
  const position = externalDisplayBounds()
  const mainWindow = new BrowserWindow({
    ...(position ?? {}),
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

const DOCK_BADGE_REFRESH_MS = 30 * 60 * 1000

// Single source of truth for the dock badge: count of 'warn' severity flags only.
// Info flags never badge — the product reserves alarm affordances for genuine warnings.
function updateDockBadge(flags: Flag[]): void {
  const warnCount = flags.filter((flag) => flag.severity === 'warn').length
  app.dock?.setBadge(warnCount > 0 ? String(warnCount) : '')
}

async function refreshDockBadge(): Promise<void> {
  try {
    const flags = await db.getTodayFlags()
    updateDockBadge(flags)
  } catch (err) {
    app.dock?.setBadge('')
    console.error('[dock-badge] failed to refresh:', err instanceof Error ? err.message : err)
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getWorkouts, (_event, fromIso: string, toIso: string) =>
    db.getWorkouts(fromIso, toIso)
  )
  ipcMain.handle(IPC_CHANNELS.getWorkoutDetail, (_event, id: string) => db.getWorkoutDetail(id))
  ipcMain.handle(IPC_CHANNELS.getWorkoutPlaces, (_event, workoutIds: string[]) =>
    db.getWorkoutPlaces(workoutIds)
  )
  ipcMain.handle(IPC_CHANNELS.getSwimSets, (_event, fromIso: string, toIso: string) =>
    db.getSwimSets(fromIso, toIso)
  )
  ipcMain.handle(IPC_CHANNELS.getDailyMetrics, (_event, fromDate: string, toDate: string) =>
    db.getDailyMetrics(fromDate, toDate)
  )
  ipcMain.handle(IPC_CHANNELS.getComputedDaily, (_event, fromDate: string, toDate: string) =>
    db.getComputedDaily(fromDate, toDate)
  )
  ipcMain.handle(IPC_CHANNELS.getZone2Fitness, (_event, fromDate: string, toDate: string) =>
    db.getZone2Fitness(fromDate, toDate)
  )
  ipcMain.handle(IPC_CHANNELS.getUserConfig, () => db.getUserConfig())
  ipcMain.handle(IPC_CHANNELS.updateUserConfig, (_event, patch: UserConfigPatch) =>
    db.updateUserConfig(patch)
  )
  ipcMain.handle(IPC_CHANNELS.getTodayFlags, async () => {
    const flags = await db.getTodayFlags()
    updateDockBadge(flags)
    return flags
  })
  ipcMain.handle(IPC_CHANNELS.getInjuries, () => db.getInjuries())
  ipcMain.handle(IPC_CHANNELS.getInjuryLog, (_event, injuryId: string) => db.getInjuryLog(injuryId))
  ipcMain.handle(IPC_CHANNELS.addInjuryLog, (_event, entry: NewInjuryLog) =>
    offlineWrites.run('addInjuryLog', [entry])
  )
  ipcMain.handle(IPC_CHANNELS.deleteInjuryLog, (_event, id: number) =>
    offlineWrites.run('deleteInjuryLog', [id])
  )
  ipcMain.handle(
    IPC_CHANNELS.updateInjuryStatus,
    (_event, injuryId: string, status: Injury['status']) =>
      offlineWrites.run('updateInjuryStatus', [injuryId, status])
  )
  ipcMain.handle(IPC_CHANNELS.deleteInjury, (_event, id: string) =>
    offlineWrites.run('deleteInjury', [id])
  )
  ipcMain.handle(IPC_CHANNELS.getInjuryPlan, (_event, injuryId: string) =>
    db.getInjuryPlan(injuryId)
  )
  ipcMain.handle(
    IPC_CHANNELS.updateInjuryPlanStart,
    (_event, injuryId: string, planStartedAt: string) =>
      offlineWrites.run('updateInjuryPlanStart', [injuryId, planStartedAt])
  )
  ipcMain.handle(
    IPC_CHANNELS.updateInjuryStartedAt,
    (_event, injuryId: string, startedAt: string) =>
      offlineWrites.run('updateInjuryStartedAt', [injuryId, startedAt])
  )
  ipcMain.handle(IPC_CHANNELS.getInjuryPlanChecks, (_event, injuryId: string, fromDate: string) =>
    db.getInjuryPlanChecks(injuryId, fromDate)
  )
  ipcMain.handle(
    IPC_CHANNELS.setPlanItemCheck,
    (_event, itemId: string, doneDate: string, done: boolean) =>
      offlineWrites.run('setPlanItemCheck', [itemId, doneDate, done])
  )
  ipcMain.handle(IPC_CHANNELS.getExercises, () => db.getExercises())
  ipcMain.handle(IPC_CHANNELS.addExercise, (_event, name: string, bodyPart: GymBodyPart | null) =>
    db.addExercise(name, bodyPart)
  )
  ipcMain.handle(IPC_CHANNELS.getGymTemplates, () => db.getGymTemplates())
  ipcMain.handle(IPC_CHANNELS.addGymTemplate, (_event, template: NewGymTemplate) =>
    offlineWrites.run('addGymTemplate', [template])
  )
  ipcMain.handle(IPC_CHANNELS.updateGymTemplate, (_event, id: string, patch: GymTemplatePatch) =>
    offlineWrites.run('updateGymTemplate', [id, patch])
  )
  ipcMain.handle(IPC_CHANNELS.deleteGymTemplate, (_event, id: string) =>
    offlineWrites.run('deleteGymTemplate', [id])
  )
  ipcMain.handle(
    IPC_CHANNELS.createGymTemplateVersion,
    (_event, baseTemplateId: string, template: NewGymTemplate) =>
      offlineWrites.run('createGymTemplateVersion', [baseTemplateId, template])
  )
  ipcMain.handle(IPC_CHANNELS.getGymTemplateVersions, (_event, familyId: string) =>
    db.getGymTemplateVersions(familyId)
  )
  ipcMain.handle(IPC_CHANNELS.startGymTemplateRun, (_event, templateId: string) =>
    offlineWrites.run('startGymTemplateRun', [templateId])
  )
  ipcMain.handle(IPC_CHANNELS.completeGymTemplateRun, (_event, templateId: string) =>
    offlineWrites.run('completeGymTemplateRun', [templateId])
  )
  ipcMain.handle(IPC_CHANNELS.getGymSessions, (_event, fromIso: string, toIso: string) =>
    db.getGymSessions(fromIso, toIso)
  )
  ipcMain.handle(IPC_CHANNELS.addGymSession, (_event, session: NewGymSession) =>
    offlineWrites.run('addGymSession', [session])
  )
  ipcMain.handle(IPC_CHANNELS.updateGymSession, (_event, id: string, patch: GymSessionPatch) =>
    offlineWrites.run('updateGymSession', [id, patch])
  )
  ipcMain.handle(IPC_CHANNELS.deleteGymSession, (_event, id: string) =>
    offlineWrites.run('deleteGymSession', [id])
  )
  ipcMain.handle(IPC_CHANNELS.getGoals, () => db.getGoals())
  ipcMain.handle(IPC_CHANNELS.getGoalProgress, (_event, goalId: string) =>
    db.getGoalProgress(goalId)
  )
  ipcMain.handle(IPC_CHANNELS.addGoal, (_event, goal: NewGoal) => db.addGoal(goal))
  ipcMain.handle(IPC_CHANNELS.updateGoal, (_event, id: string, patch: GoalPatch) =>
    db.updateGoal(id, patch)
  )
  ipcMain.handle(IPC_CHANNELS.deleteGoal, (_event, id: string) => db.deleteGoal(id))
  ipcMain.handle(IPC_CHANNELS.buildGoalMetric, (_event, goalId: string) =>
    chat.buildGoalMetric(goalId)
  )
  ipcMain.handle(IPC_CHANNELS.getProteinLog, (_event, fromDate: string, toDate: string) =>
    db.getProteinLog(fromDate, toDate)
  )
  ipcMain.handle(IPC_CHANNELS.addProtein, (_event, date: string, grams: number) =>
    offlineWrites.run('addProtein', [date, grams])
  )
  ipcMain.handle(IPC_CHANNELS.setProtein, (_event, date: string, grams: number) =>
    offlineWrites.run('setProtein', [date, grams])
  )
  ipcMain.handle(IPC_CHANNELS.getOfflineQueueStatus, () => offlineWrites.status())
  ipcMain.handle(IPC_CHANNELS.retryOfflineQueue, async () => {
    await offlineWrites.retryFailed()
    await offlineWrites.flush()
    return offlineWrites.status()
  })
  ipcMain.handle(IPC_CHANNELS.getDbStatus, () => db.getDbStatus())
  ipcMain.handle(IPC_CHANNELS.getLastIngestAt, () => db.getLastIngestAt())
  ipcMain.handle(IPC_CHANNELS.getInsightCorrelations, () => db.getInsightCorrelations())
  ipcMain.handle(IPC_CHANNELS.getInsightModels, () => db.getInsightModels())
  ipcMain.handle(IPC_CHANNELS.chatStatus, () => chat.checkClaude())
  ipcMain.handle(IPC_CHANNELS.chatListSessions, () => db.listChatSessions())
  ipcMain.handle(IPC_CHANNELS.chatGetSession, (_event, id: string) => db.getChatSession(id))
  ipcMain.handle(IPC_CHANNELS.chatPickAttachments, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('no window for attachment picker')
    return chat.pickChatAttachments(win)
  })
  ipcMain.handle(IPC_CHANNELS.chatValidateAttachments, (_event, paths: unknown) =>
    chat.validateChatAttachments(paths)
  )
  ipcMain.handle(
    IPC_CHANNELS.chatSend,
    (event, sessionId: string | null, message: string, attachmentPaths: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('no window for chat send')
      return chat.sendMessage(win, sessionId, message, attachmentPaths)
    }
  )
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.healthanalytics.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupTileProtocol()
  registerIpcHandlers()
  createWindow()

  void offlineWrites.flush()
  setInterval(() => { void offlineWrites.flush() }, 30_000)

  void refreshDockBadge()
  setInterval(refreshDockBadge, DOCK_BADGE_REFRESH_MS)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
