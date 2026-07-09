import type { ReactElement } from 'react'
import './ChipFilter.css'

export type ChipRange = '7d' | '30d' | '90d' | '1y'

const RANGES: ChipRange[] = ['7d', '30d', '90d', '1y']

export interface ChipFilterProps {
  value: ChipRange
  onChange: (value: ChipRange) => void
  options?: ChipRange[]
}

export function ChipFilter({ value, onChange, options = RANGES }: ChipFilterProps): ReactElement {
  return (
    <div className="chip-filter" role="tablist" aria-label="Date range">
      {options.map((option) => (
        <button
          key={option}
          role="tab"
          aria-selected={option === value}
          className={option === value ? 'chip chip--active' : 'chip'}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
