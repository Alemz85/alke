import { useCallback, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Moon, RefreshCw, Sun } from 'lucide-react'
import { Sidebar } from './Sidebar'
import type { TabId } from './tabs'
import { ButtonSoft } from './components'
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

function readInitialTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard')
  const [theme, setTheme] = useState<Theme>(readInitialTheme)
  const queryClient = useQueryClient()
  const dbStatus = useDbStatus()

  const handleRefresh = (): void => {
    queryClient.invalidateQueries()
  }

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
            <ButtonSoft onClick={handleRefresh} aria-label="Refresh">
              <RefreshCw size={16} strokeWidth={1.5} />
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
    </div>
  )
}

export default App
