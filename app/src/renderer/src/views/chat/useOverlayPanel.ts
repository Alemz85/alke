import { useEffect, useRef, useState, type RefObject } from 'react'

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  'a[href]',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

interface OverlayPanelState<T extends HTMLElement> {
  panelRef: RefObject<T | null>
  overlay: boolean
}

export function useOverlayPanel<T extends HTMLElement>(
  query: string,
  open: boolean,
  onClose: () => void
): OverlayPanelState<T> {
  const panelRef = useRef<T>(null)
  const [overlay, setOverlay] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (): void => setOverlay(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  useEffect(() => {
    if (!open || !overlay) return
    const panel = panelRef.current
    if (!panel) return
    const frame = requestAnimationFrame(() => {
      panel.querySelector<HTMLElement>(FOCUSABLE)?.focus() ?? panel.focus()
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getAttribute('aria-hidden') !== 'true'
      )
      if (!focusable.length) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1) ?? first
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, open, overlay])

  return { panelRef, overlay }
}
