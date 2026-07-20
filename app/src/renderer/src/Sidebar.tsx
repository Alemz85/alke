import type { ReactElement } from 'react'
import {
  LayoutDashboard,
  Waves,
  Dumbbell,
  Moon,
  Sparkles,
  Bandage,
  MessageSquare,
  CircleUser,
  Settings
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
  { id: 'zone2', label: 'Cardio', icon: Waves },
  { id: 'gym', label: 'Gym', icon: Dumbbell },
  { id: 'recovery', label: 'Recovery', icon: Moon },
  { id: 'insights', label: 'Insights', icon: Sparkles },
  { id: 'injuries', label: 'Injuries', icon: Bandage },
  { id: 'chat', label: 'Chat', icon: MessageSquare }
]

const FOOTER_NAV_ITEMS: NavItem[] = [
  { id: 'profile', label: 'Profile', icon: CircleUser },
  { id: 'settings', label: 'Settings', icon: Settings }
]

export interface SidebarProps {
  active: TabId
  onSelect: (tab: TabId) => void
}

function renderNavItem(item: NavItem, active: TabId, onSelect: (tab: TabId) => void): ReactElement {
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
}

export function Sidebar({ active, onSelect }: SidebarProps): ReactElement {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-brand">
        <svg
          className="sidebar-brand-mark"
          viewBox="0 0 100 100"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M16 29c19-14 31 10 49 1 7-3 12-8 17-15M16 51c20-12 31 12 51 2 6-3 11-8 15-14M16 73c20-10 30 10 50 1 7-4 12-9 16-15"
            fill="none"
            stroke="currentColor"
            strokeWidth="11"
            strokeLinecap="round"
          />
        </svg>
        <span className="sidebar-brand-wordmark">alke</span>
      </div>
      <ul className="sidebar-list">
        {NAV_ITEMS.map((item) => renderNavItem(item, active, onSelect))}
      </ul>
      <ul className="sidebar-list sidebar-list--footer">
        {FOOTER_NAV_ITEMS.map((item) => renderNavItem(item, active, onSelect))}
      </ul>
    </nav>
  )
}
