import type { ReactElement } from 'react'
import {
  LayoutDashboard,
  Waves,
  ListChecks,
  Moon,
  Sparkles,
  MessageSquare
} from 'lucide-react'
import type { TabId } from './tabs'
import './Sidebar.css'

interface NavItem {
  id: TabId
  label: string
  icon: typeof LayoutDashboard
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'zone2', label: 'Zone 2', icon: Waves },
  { id: 'sessions', label: 'Sessions', icon: ListChecks },
  { id: 'recovery', label: 'Recovery', icon: Moon },
  { id: 'insights', label: 'Insights', icon: Sparkles },
  { id: 'chat', label: 'Chat', icon: MessageSquare }
]

export interface SidebarProps {
  active: TabId
  onSelect: (tab: TabId) => void
}

export function Sidebar({ active, onSelect }: SidebarProps): ReactElement {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-brand">Health</div>
      <ul className="sidebar-list">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = item.id === active
          return (
            <li key={item.id}>
              <button
                className={isActive ? 'sidebar-item sidebar-item--active' : 'sidebar-item'}
                onClick={() => onSelect(item.id)}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={18} strokeWidth={1.5} className="sidebar-item-icon" />
                <span className="sidebar-item-label">{item.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
