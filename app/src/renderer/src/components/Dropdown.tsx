import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import './Dropdown.css'

export interface DropdownOption {
  value: string
  label: string
  /** Optional leading icon (e.g. an activity's modality icon). */
  icon?: ReactNode
  /** Optional accent CSS color (e.g. 'var(--color-env-water)') tinting this
   *  option's icon. */
  accent?: string
}

export interface DropdownProps {
  /** Accessible name for the control (e.g. "Filter by time"). */
  ariaLabel: string
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  /** Which edge the popover menu aligns to. Default 'right' (header-row filters). */
  align?: 'left' | 'right'
}

/**
 * A compact, dark-themed select: a quiet trigger showing the current option's
 * label + chevron, opening a popover listbox. Custom (not native <select>) so
 * the option list obeys the app's tokens instead of the OS chrome.
 */
export function Dropdown({
  ariaLabel,
  value,
  options,
  onChange,
  align = 'right'
}: DropdownProps): ReactElement {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="dropdown" ref={wrapRef}>
      <button
        type="button"
        className="dropdown-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.icon && (
          <span className="dropdown-trigger-icon" style={{ color: current.accent }}>
            {current.icon}
          </span>
        )}
        <span className="dropdown-trigger-label">{current?.label ?? ''}</span>
        <ChevronDown size={14} strokeWidth={1.5} className="dropdown-trigger-chevron" />
      </button>

      {open && (
        <ul
          className={align === 'left' ? 'dropdown-menu dropdown-menu--left' : 'dropdown-menu'}
          role="listbox"
          id={listId}
          aria-label={ariaLabel}
        >
          {options.map((option) => {
            const selected = option.value === value
            return (
              <li
                key={option.value}
                role="option"
                aria-selected={selected}
                className="dropdown-option-row"
              >
                <button
                  type="button"
                  className={selected ? 'dropdown-option is-selected' : 'dropdown-option'}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="dropdown-option-main">
                    {option.icon && (
                      <span className="dropdown-option-icon" style={{ color: option.accent }}>
                        {option.icon}
                      </span>
                    )}
                    <span className="dropdown-option-label">{option.label}</span>
                  </span>
                  {selected && <Check size={14} strokeWidth={2} className="dropdown-option-check" />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
