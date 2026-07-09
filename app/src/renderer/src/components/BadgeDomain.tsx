import type { ReactElement } from 'react'
import type { Domain } from './domain'
import './BadgeDomain.css'

export interface BadgeDomainProps {
  domain: Domain
  label: string
}

export function BadgeDomain({ domain, label }: BadgeDomainProps): ReactElement {
  return (
    <span className={`badge-domain badge-domain--${domain}`}>
      <span className="tabular-nums">{label}</span>
    </span>
  )
}
