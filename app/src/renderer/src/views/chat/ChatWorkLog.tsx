import type { ReactElement } from 'react'
import { ChevronRight, ListTree, Terminal, X } from 'lucide-react'
import type { ChatRuntimeSnapshot } from '@shared/types'
import { useOverlayPanel } from './useOverlayPanel'

interface ChatWorkLogProps {
  runtime: ChatRuntimeSnapshot
  open: boolean
  onOpen(): void
  onClose(): void
}

export function ChatWorkLogSummary({
  runtime,
  onOpen
}: Pick<ChatWorkLogProps, 'runtime' | 'onOpen'>): ReactElement {
  const current = runtime.workLog.at(-1)?.label ?? phaseLabel(runtime)
  const count = runtime.workLog.length
  return (
    <button type="button" className="chat-worklog-summary" onClick={onOpen}>
      <ListTree size={14} strokeWidth={1.6} aria-hidden="true" />
      <span>{current}</span>
      {count > 0 && <span className="chat-worklog-count">{count}</span>}
      <ChevronRight size={14} strokeWidth={1.6} aria-hidden="true" />
    </button>
  )
}

export function ChatWorkLog({ runtime, open, onOpen, onClose }: ChatWorkLogProps): ReactElement {
  const { panelRef, overlay } = useOverlayPanel<HTMLElement>('(max-width: 920px)', open, onClose)

  return (
    <aside
      ref={panelRef}
      id="chat-worklog"
      className={`chat-worklog${open ? ' is-open' : ''}`}
      aria-label="Work log"
      role={open && overlay ? 'dialog' : undefined}
      aria-modal={open && overlay ? true : undefined}
      tabIndex={open && overlay ? -1 : undefined}
    >
      <div className="chat-worklog-header">
        <div>
          <span className="chat-panel-label">Work log</span>
          <p>{phaseLabel(runtime)}</p>
        </div>
        <button
          type="button"
          className="chat-icon-button"
          onClick={onClose}
          aria-label="Close work log"
          title="Close work log"
        >
          <X size={16} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
      {runtime.workLog.length === 0 ? (
        <p className="chat-worklog-empty">
          Activity will appear here as Alke reads data and completes local work.
        </p>
      ) : (
        <ol className="chat-worklog-list">
          {runtime.workLog.map((entry) => (
            <li key={`${entry.sequence}-${entry.label}`} className="chat-worklog-entry">
              <span className="chat-worklog-entry-icon" aria-hidden="true">
                <Terminal size={13} strokeWidth={1.5} />
              </span>
              <div>
                <div className="chat-worklog-entry-head">
                  <span>{entry.label}</span>
                  <time dateTime={entry.at}>{WORK_TIME_FORMATTER.format(new Date(entry.at))}</time>
                </div>
                {entry.detail && (
                  <details>
                    <summary>Details</summary>
                    <pre>{entry.detail}</pre>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {!open && (
        <button type="button" className="chat-worklog-open-fallback" onClick={onOpen}>
          Open work log
        </button>
      )}
    </aside>
  )
}

function phaseLabel(runtime: ChatRuntimeSnapshot): string {
  const labels: Record<ChatRuntimeSnapshot['phase'], string> = {
    starting: 'Starting',
    running: 'Working',
    stopping: 'Stopping',
    completed: 'Completed',
    failed: 'Needs attention',
    interrupted: 'Interrupted'
  }
  return labels[runtime.phase]
}

const WORK_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})
