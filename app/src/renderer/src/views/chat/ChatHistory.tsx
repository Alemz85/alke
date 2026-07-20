import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { Check, Pencil, Plus, Square, Trash2, X } from 'lucide-react'
import type { ChatRuntimeSnapshot, ChatSessionMeta } from '@shared/types'
import { useOverlayPanel } from './useOverlayPanel'

interface ChatHistoryProps {
  sessions: ChatSessionMeta[]
  selectedId: string | null
  runtime: ChatRuntimeSnapshot | null
  open: boolean
  onClose(): void
  onNew(): void
  onSelect(sessionId: string): void
  onRenamed(): void
  onDeleted(sessionId: string): void
  onStop(sessionId: string): void
}

function isRuntimeActive(runtime: ChatRuntimeSnapshot | null): boolean {
  return Boolean(runtime && ['starting', 'running', 'stopping'].includes(runtime.phase))
}

export function ChatHistory({
  sessions,
  selectedId,
  runtime,
  open,
  onClose,
  onNew,
  onSelect,
  onRenamed,
  onDeleted,
  onStop
}: ChatHistoryProps): ReactElement {
  const { panelRef, overlay } = useOverlayPanel<HTMLElement>('(max-width: 1180px)', open, onClose)

  return (
    <aside
      ref={panelRef}
      id="chat-history"
      className={`chat-history${open ? ' is-open' : ''}`}
      aria-label="Conversation history"
      role={open && overlay ? 'dialog' : undefined}
      aria-modal={open && overlay ? true : undefined}
      tabIndex={open && overlay ? -1 : undefined}
    >
      <div className="chat-history-header">
        <span className="chat-panel-label">History</span>
        <button
          type="button"
          className="chat-icon-button chat-drawer-close"
          onClick={onClose}
          aria-label="Close conversation history"
          title="Close history"
        >
          <X size={16} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        className="chat-new-button"
        onClick={() => {
          onNew()
          if (overlay) onClose()
        }}
      >
        <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
        New analysis
      </button>
      <div className="chat-history-list">
        {sessions.length === 0 ? (
          <p className="chat-history-empty">Your analyses will appear here.</p>
        ) : (
          sessions.map((session) => {
            const ownsRuntime = runtime?.sessionId === session.id
            const running = ownsRuntime && isRuntimeActive(runtime)
            const interrupted = ownsRuntime && runtime?.phase === 'interrupted'
            return (
              <SessionRow
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                running={running}
                interrupted={interrupted}
                onOpen={() => {
                  onSelect(session.id)
                  if (overlay) onClose()
                }}
                onRenamed={onRenamed}
                onDeleted={() => onDeleted(session.id)}
                onStop={() => onStop(session.id)}
              />
            )
          })
        )}
      </div>
    </aside>
  )
}

function SessionRow({
  session,
  selected,
  running,
  interrupted,
  onOpen,
  onRenamed,
  onDeleted,
  onStop
}: {
  session: ChatSessionMeta
  selected: boolean
  running: boolean
  interrupted: boolean
  onOpen(): void
  onRenamed(): void
  onDeleted(): void
  onStop(): void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    },
    []
  )

  const saveTitle = async (): Promise<void> => {
    const nextTitle = title.trim()
    setEditing(false)
    if (!nextTitle || nextTitle === (session.title ?? '')) return
    await window.api.chatRename(session.id, nextTitle)
    onRenamed()
  }

  const startEditing = (event: MouseEvent): void => {
    event.stopPropagation()
    setTitle(session.title ?? '')
    setEditing(true)
  }

  const handleDelete = (event: MouseEvent): void => {
    event.stopPropagation()
    if (running) {
      onStop()
      return
    }
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      confirmTimer.current = setTimeout(() => setConfirmingDelete(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmingDelete(false)
    void window.api.chatDelete(session.id).then(onDeleted)
  }

  if (editing) {
    return (
      <div className="chat-history-row is-editing">
        <input
          ref={inputRef}
          className="chat-history-title-input"
          name="conversation-title"
          autoComplete="off"
          value={title}
          aria-label="Conversation title"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveTitle()
            if (event.key === 'Escape') setEditing(false)
          }}
          onBlur={() => void saveTitle()}
        />
        <button
          type="button"
          className="chat-icon-button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void saveTitle()}
          aria-label="Save conversation title"
          title="Save title"
        >
          <Check size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <div className={`chat-history-row${selected ? ' is-selected' : ''}`}>
      <button type="button" className="chat-history-open" onClick={onOpen}>
        <span className="chat-history-title">{session.title ?? 'Untitled analysis'}</span>
        <span className="chat-history-meta">
          {running
            ? 'Working'
            : interrupted
              ? 'Interrupted'
              : formatSessionDate(session.started_at)}
        </span>
      </button>
      <div className="chat-history-actions">
        <button
          type="button"
          className="chat-icon-button"
          onClick={startEditing}
          aria-label={`Rename ${session.title ?? 'Untitled analysis'}`}
          title="Rename"
        >
          <Pencil size={13} strokeWidth={1.6} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`chat-icon-button${confirmingDelete ? ' is-confirming' : ''}`}
          onClick={handleDelete}
          aria-label={
            running
              ? `Stop ${session.title ?? 'analysis'} before deleting`
              : confirmingDelete
                ? `Confirm delete ${session.title ?? 'analysis'}`
                : `Delete ${session.title ?? 'analysis'}`
          }
          title={
            running ? 'Stop response first' : confirmingDelete ? 'Click again to delete' : 'Delete'
          }
        >
          {running ? (
            <Square size={11} fill="currentColor" aria-hidden="true" />
          ) : (
            <Trash2 size={13} strokeWidth={1.6} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  )
}

function formatSessionDate(value: string): string {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return SESSION_TIME_FORMATTER.format(date)
  }
  return SESSION_DATE_FORMATTER.format(date)
}

const SESSION_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})

const SESSION_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
})
