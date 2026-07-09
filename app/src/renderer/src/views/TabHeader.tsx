import type { ReactElement } from 'react'
import './TabHeader.css'

export interface TabHeaderProps {
  eyebrow: string
  title: string
}

export function TabHeader({ eyebrow, title }: TabHeaderProps): ReactElement {
  return (
    <div className="tab-header">
      <div className="tab-header-eyebrow">{eyebrow}</div>
      <h1 className="tab-header-title">{title}</h1>
    </div>
  )
}
