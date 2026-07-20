import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Calculator, Moon, RefreshCw, Sun } from 'lucide-react'
import { Sidebar } from './Sidebar'
import type { TabId } from './tabs'
import { ButtonSoft, OfflineQueueStatus, Toast, type ToastTone } from './components'
import { useDbStatus } from './hooks/useDbStatus'
import { useOfflineQueue } from './hooks/useOfflineQueue'
import { invalidateWorkoutViews } from './hooks/useGymData'
import { subscribeMutationErrors } from './lib/mutationFeedback'
import { ChatRuntimeProvider } from './chat/ChatRuntimeProvider'
import { DbErrorState } from './views/DbErrorState'
import { DashboardView } from './views/DashboardView'
import { Zone2View } from './views/Zone2View'
import { SessionsView } from './views/SessionsView'
import { GymView } from './views/GymView'
import { RecoveryView } from './views/RecoveryView'
import { InsightsView } from './views/InsightsView'
import { InjuriesView } from './views/InjuriesView'
import { ChatView } from './views/ChatView'
import { ProfileView } from './views/ProfileView'
import { SettingsView } from './views/SettingsView'
import './App.css'

// Views that need no navigation wiring render from this map directly. Dashboard,
// Sessions, and Cardio (Zone2) cross-link, so they're special-cased in the render
// below (they receive an onOpenSessions / onBack callback) rather than listed here.
const VIEWS: Record<Exclude<TabId, 'dashboard' | 'sessions' | 'zone2'>, () => ReactElement> = {
  gym: GymView,
  recovery: RecoveryView,
  insights: InsightsView,
  injuries: InjuriesView,
  chat: ChatView,
  profile: ProfileView,
  settings: SettingsView
}

// Tabs whose views read the shared workout-range queries (useAllWorkouts,
// useYearWorkouts, useMonthWorkouts, useRecentWorkouts, useWorkoutsInRange).
// App.tsx renders exactly one tab's view at a time (see renderActiveView
// below), so navigating to one of these is a fresh mount — but React
// Query's refetchOnMount only refetches queries that are already stale;
// data ingested (or a gym session logged) while this tab wasn't mounted can
// sit in cache well within the 60s staleTime and never get picked up.
// Invalidating on activation forces that refetch without lowering
// staleTime/gcTime globally, so the localStorage persistence layer keeps
// doing its job (instant cold-start paint, stale-but-shown data if the DB
// is briefly unreachable) for every other query.
const WORKOUT_VIEW_TABS: ReadonlySet<TabId> = new Set(['dashboard', 'sessions', 'zone2', 'gym'])

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
  // Activity group to pre-filter the Sessions view with on the next visit (set
  // when a cardio "recent sessions" card deep-links in). Cleared whenever
  // Sessions is opened without a filter (sidebar, Dashboard "All sessions").
  const [sessionsActivity, setSessionsActivity] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(readInitialTheme)
  const [refreshing, setRefreshing] = useState(false)
  const [recomputing, setRecomputing] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const queryClient = useQueryClient()
  const dbStatus = useDbStatus()
  const offlineQueue = useOfflineQueue()

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

  useEffect(
    () =>
      subscribeMutationErrors((message) => {
        setToast({ message, tone: 'error' })
      }),
    []
  )

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await offlineQueue.retry()
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
  }, [offlineQueue, queryClient, refreshing])

  const handleRecomputeMetrics = useCallback(async (): Promise<void> => {
    if (recomputing) return
    setRecomputing(true)
    try {
      const result = await window.api.runMetricsJob()
      if (result.ok) {
        const seconds = Math.round(result.durationMs / 1000)
        setToast({
          message: result.summaryLines[0] ?? `Metrics recomputed in ${seconds}s.`,
          tone: 'success'
        })
        // Recomputed CTL/TSB, zone2, and insights only exist in the DB after
        // this resolves — refetch so the new numbers show without a restart.
        await queryClient.refetchQueries()
      } else {
        setToast({
          message: `Couldn't recompute metrics — ${result.error ?? 'unknown error'}.`,
          tone: 'error'
        })
      }
    } catch (err) {
      setToast({
        message: `Couldn't recompute metrics — ${
          err instanceof Error ? err.message : 'unknown error'
        }.`,
        tone: 'error'
      })
    } finally {
      setRecomputing(false)
    }
  }, [queryClient, recomputing])

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

  const connected = dbStatus.data?.connected !== false
  const hasCachedHealthData = queryClient
    .getQueryCache()
    .getAll()
    .some((query) => {
      const prefix = query.queryKey[0]
      return prefix !== 'dbStatus' && prefix !== 'chat' && query.state.data !== undefined
    })
  const showDbError = dbStatus.data?.connected === false && !hasCachedHealthData

  // Open the Sessions tab, optionally pre-filtered to an activity group (e.g. a
  // cardio recent-sessions card passes "Swim"). No argument = show everything.
  const openSessions = useCallback(
    (activity?: string): void => {
      setSessionsActivity(activity ?? null)
      setActiveTab('sessions')
      invalidateWorkoutViews(queryClient)
    },
    [queryClient]
  )

  // Sidebar navigation clears any pending Sessions filter so a manual tab click
  // always lands on the full, unfiltered list.
  const handleSelectTab = useCallback(
    (tab: TabId): void => {
      if (tab === 'sessions') setSessionsActivity(null)
      setActiveTab(tab)
      if (WORKOUT_VIEW_TABS.has(tab)) invalidateWorkoutViews(queryClient)
    },
    [queryClient]
  )

  function renderActiveView(): ReactElement {
    if (activeTab === 'dashboard') {
      return (
        <DashboardView
          onOpenSessions={() => openSessions()}
          onOpenProfile={() => setActiveTab('profile')}
        />
      )
    }
    if (activeTab === 'sessions') {
      return (
        <SessionsView
          onBack={() => setActiveTab('dashboard')}
          initialActivity={sessionsActivity ?? undefined}
        />
      )
    }
    if (activeTab === 'zone2') {
      return <Zone2View onOpenSessions={openSessions} />
    }
    const ActiveView = VIEWS[activeTab]
    return <ActiveView />
  }

  return (
    <ChatRuntimeProvider>
      <div className="app-shell">
        <Sidebar active={activeTab} onSelect={handleSelectTab} />
        <main className={activeTab === 'chat' ? 'content-area content-area--chat' : 'content-area'}>
          <div className="content-area-inner">
            <div className="content-area-toolbar">
              <OfflineQueueStatus
                connected={connected}
                status={offlineQueue.status}
                onRetry={() => {
                  void offlineQueue.retry()
                }}
              />
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
              <ButtonSoft
                className="button-soft--icon"
                onClick={() => {
                  void handleRecomputeMetrics()
                }}
                aria-label="Recompute metrics"
                title="Run the nightly metrics job now"
                disabled={recomputing}
              >
                <Calculator
                  size={16}
                  strokeWidth={1.5}
                  className={recomputing ? 'icon-spin' : undefined}
                />
              </ButtonSoft>
            </div>
            {showDbError ? (
              <DbErrorState message={dbStatus.data?.error} onRetry={() => dbStatus.refetch()} />
            ) : (
              renderActiveView()
            )}
          </div>
        </main>
        {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismissToast} />}
      </div>
    </ChatRuntimeProvider>
  )
}

export default App
