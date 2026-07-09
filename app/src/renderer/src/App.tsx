import { useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
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
import { ChatView } from './views/ChatView'
import './App.css'

const VIEWS: Record<TabId, () => ReactElement> = {
  dashboard: DashboardView,
  zone2: Zone2View,
  sessions: SessionsView,
  recovery: RecoveryView,
  insights: InsightsView,
  chat: ChatView
}

function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard')
  const queryClient = useQueryClient()
  const dbStatus = useDbStatus()

  const handleRefresh = (): void => {
    queryClient.invalidateQueries()
  }

  const ActiveView = VIEWS[activeTab]
  const showDbError = dbStatus.isSuccess && dbStatus.data && !dbStatus.data.connected

  return (
    <div className="app-shell">
      <Sidebar active={activeTab} onSelect={setActiveTab} />
      <main className="content-area">
        <div className="content-area-inner">
          <div className="content-area-toolbar">
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
