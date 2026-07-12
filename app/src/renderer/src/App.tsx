import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Moon, RefreshCw, Sun } from 'lucide-react'
import { Sidebar } from './Sidebar'
import type { TabId } from './tabs'
import { ButtonSoft, Toast, type ToastTone } from './components'
import { useDbStatus } from './hooks/useDbStatus'
import { DbErrorState } from './views/DbErrorState'
import { DashboardView } from './views/DashboardView'
import { Zone2View } from './views/Zone2View'
import { SessionsView } from './views/SessionsView'
import { RecoveryView } from './views/RecoveryView'
import { InsightsView } from './views/InsightsView'
import { InjuriesView } from './views/InjuriesView'
import { ChatView } from './views/ChatView'
import { ProfileView } from './views/ProfileView'
import { SettingsView } from './views/SettingsView'
import './App.css'

const VIEWS: Record<TabId, () => ReactElement> = {
  dashboard: DashboardView,
  zone2: Zone2View,
  sessions: SessionsView,
  recovery: RecoveryView,
  insights: InsightsView,
  injuries: InjuriesView,
  chat: ChatView,
  profile: ProfileView,
  settings: SettingsView
}

type Theme = 'dark' | 'light'

interface ToastState {
  message: string
  tone: ToastTone
}

function readInitialTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

/** Compact "just now / 12 min ago / 3 h ago / 2 d ago" from an ISO instant. */
function fmtRelativeTime(iso: string): string {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffH = Math.round(diffMin / 60)
  if (diffH < 24) return `${diffH} h ago`
  return `${Math.round(diffH / 24)} d ago`
}

function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard')
  const [theme, setTheme] = useState<Theme>(readInitialTheme)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const queryClient = useQueryClient()
  const dbStatus = useDbStatus()

  // Freshness baseline: the newest ingest timestamp we've observed. Seeded once
  // on mount so the first manual Refresh has something to compare against.
  // `undefined` = not yet probed (skip the new/stale verdict for that refresh).
  const lastIngestRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    window.api.getLastIngestAt().then(
      (v) => {
        lastIngestRef.current = v
      },
      () => {
        /* leave undefined — a failed seed just means the next refresh reports plain success */
      }
    )
  }, [])

  const dismissToast = useCallback((): void => setToast(null), [])

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      // The ingest probe shares the DB connection, so if it resolves the data
      // reads did too; if the DB is unreachable it throws and we surface that.
      const [, latest] = await Promise.all([
        queryClient.refetchQueries(),
        window.api.getLastIngestAt()
      ])
      const prev = lastIngestRef.current
      if (prev === undefined) {
        setToast({ message: 'Refreshed with the latest data.', tone: 'success' })
      } else if (latest !== null && (prev === null || latest > prev)) {
        setToast({
          message: `Updated — new data received ${fmtRelativeTime(latest)}.`,
          tone: 'success'
        })
      } else {
        setToast({
          message: 'Already up to date — no new data since your last refresh.',
          tone: 'info'
        })
      }
      lastIngestRef.current = latest
    } catch (err) {
      setToast({
        message: `Couldn't refresh — ${
          err instanceof Error ? err.message : 'the database is unreachable'
        }.`,
        tone: 'error'
      })
    } finally {
      setRefreshing(false)
    }
  }, [queryClient, refreshing])

  const toggleTheme = useCallback((): void => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      if (next === 'light') {
        document.documentElement.setAttribute('data-theme', 'light')
      } else {
        document.documentElement.removeAttribute('data-theme')
      }
      try {
        localStorage.setItem('theme', next)
      } catch {
        /* localStorage unavailable — theme still applies for this session */
      }
      return next
    })
  }, [])

  const ActiveView = VIEWS[activeTab]
  const showDbError = dbStatus.isSuccess && dbStatus.data && !dbStatus.data.connected

  return (
    <div className="app-shell">
      <Sidebar active={activeTab} onSelect={setActiveTab} />
      <main className="content-area">
        <div className="content-area-inner">
          <div className="content-area-toolbar">
            <ButtonSoft
              className="button-soft--icon"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? (
                <Sun size={18} strokeWidth={1.5} />
              ) : (
                <Moon size={18} strokeWidth={1.5} />
              )}
            </ButtonSoft>
            <ButtonSoft onClick={handleRefresh} aria-label="Refresh" disabled={refreshing}>
              <RefreshCw
                size={16}
                strokeWidth={1.5}
                className={refreshing ? 'icon-spin' : undefined}
              />
              Refresh
            </ButtonSoft>
          </div>
          {showDbError ? (
            <DbErrorState message={dbStatus.data?.error} onRetry={() => dbStatus.refetch()} />
          ) : (
            <ActiveView />
          )}
        </div>
      </main>
      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismissToast} />}
    </div>
  )
}

export default App
