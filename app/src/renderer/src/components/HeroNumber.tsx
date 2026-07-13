import { useEffect, useRef, useState, type ReactElement } from 'react'
import './HeroNumber.css'

export interface HeroNumberProps {
  /** Target value. `null` renders the em-dash placeholder and animates once a value arrives. */
  value: number | null
  /** Caller-owned formatter — controls decimals, units, clock format, etc. */
  format: (n: number) => string
  className?: string
}

const EM_DASH = '—'
const DURATION_MS = 650

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** cubic ease-out — matches --ease-out-quart's settle-fast, no-bounce feel. */
function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4)
}

/**
 * Renders a number that counts up from its previous value (or 0 on first
 * mount) to `value` over ~650ms whenever `value` meaningfully changes.
 * Purely presentational — no data fetching. Reduced-motion and null values
 * both skip the animation and render the final state instantly.
 */
export function HeroNumber({ value, format, className }: HeroNumberProps): ReactElement {
  const [display, setDisplay] = useState<number | null>(value)
  const prevValueRef = useRef<number | null>(value)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const prev = prevValueRef.current
    prevValueRef.current = value

    if (value === null) {
      setDisplay(null)
      return
    }

    if (prevReducedMotionOrUnchanged(prev, value)) {
      setDisplay(value)
      return
    }

    const start = prev ?? 0
    const delta = value - start
    const startTime = performance.now()

    function tick(now: number): void {
      const elapsed = now - startTime
      const t = Math.min(1, elapsed / DURATION_MS)
      const eased = easeOutQuart(t)
      setDisplay(start + delta * eased)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setDisplay(value)
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function prevReducedMotionOrUnchanged(prev: number | null, next: number): boolean {
    if (prefersReducedMotion()) return true
    return prev === next
  }

  return (
    <span className={className ? `hero-number tabular-nums ${className}` : 'hero-number tabular-nums'}>
      {display === null ? EM_DASH : format(display)}
    </span>
  )
}
