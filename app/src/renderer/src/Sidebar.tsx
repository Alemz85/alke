import type { ReactElement } from 'react'
import {
  LayoutDashboard,
  Waves,
  ListChecks,
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
  { id: 'zone2', label: 'Zone 2', icon: Waves },
  { id: 'sessions', label: 'Sessions', icon: ListChecks },
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
      <div className="sidebar-brand">Health</div>
      <ul className="sidebar-list">
        {NAV_ITEMS.map((item) => renderNavItem(item, active, onSelect))}
      </ul>
      <ul className="sidebar-list sidebar-list--footer">
        {FOOTER_NAV_ITEMS.map((item) => renderNavItem(item, active, onSelect))}
      </ul>
    </nav>
  )
}
