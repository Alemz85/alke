import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent, ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  Paperclip,
  Pencil,
  Plus,
  Square,
  Trash2,
  X
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  CHAT_MODES,
  MAX_CHAT_ATTACHMENTS,
  type ChatAttachment,
  type ChatMessage,
  type ChatMode,
  type ChatSessionMeta,
  type ChatStreamEvent
} from '@shared/types'
import { TabHeader } from './TabHeader'
import { ButtonSoft } from '../components'
import './ChatView.css'

interface StreamBlock {
  kind: 'text' | 'tool'
  text: string
  name?: string
}

const SUGGESTED_PROMPTS = [
  'Summarize my last 2 weeks',
  'Is my swim efficiency improving?',
  'Design next week given my current load'
]

const DEFAULT_CHAT_MODE: ChatMode = 'analysis'

const CHAT_MODE_LABELS: Record<ChatMode, string> = {
  analysis: 'Analysis',
  injuries: 'Injuries',
  goals: 'Goals'
}

/**
 * The mode picker is only meaningful before a CLI session has opened: chat.ts
 * prefixes `/health <mode>` ONLY on a fresh CLI session (a resumed session's
 * context already carries its mode's instruction files — see chat.ts's
 * sendMessage), so mode is fixed for that session's lifetime and switching it
 * afterward would be a no-op at best, misleading at worst. "Not yet begun"
 * means no session has been opened for this composition (activeId is null,
 * the state newAnalysis() resets to) AND no messages have been exchanged yet
 * (guards the brief window between the optimistic user-message append and the
 * chatSend response setting activeId, during the very first send).
 */
export function isComposingNewChat(activeId: string | null, messages: ChatMessage[]): boolean {
  return activeId === null && messages.length === 0
}

export function ChatView(): ReactElement {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['chat', 'status'],
    queryFn: () => window.api.chatStatus()
  })
  const sessionsQuery = useQuery({
    queryKey: ['chat', 'sessions'],
    queryFn: () => window.api.chatListSessions()
  })

  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [mode, setMode] = useState<ChatMode>(DEFAULT_CHAT_MODE)
  const [stream, setStream] = useState<StreamBlock[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const activeIdRef = useRef<string | null>(null)
  const dragCounterRef = useRef(0)
  activeIdRef.current = activeId

  useEffect(() => {
    return window.api.onChatStream(({ sessionId, event }) => {
      if (sessionId !== activeIdRef.current) return
      applyEvent(event)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function applyEvent(event: ChatStreamEvent): void {
    if (event.kind === 'text') {
      setStream((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.kind === 'text') {
          return [...prev.slice(0, -1), { ...last, text: last.text + event.text }]
        }
        return [...prev, { kind: 'text', text: event.text }]
      })
    } else if (event.kind === 'tool') {
      setStream((prev) => [...prev, { kind: 'tool', name: event.name, text: event.detail }])
    } else if (event.kind === 'done') {
      setStream((prev) => {
        const text = prev
          .filter((b) => b.kind === 'text')
          .map((b) => b.text)
          .join('\n\n')
        if (text.trim()) {
          setMessages((m) => [
            ...m,
            { role: 'assistant', content: text, ts: new Date().toISOString() }
          ])
        }
        return []
      })
      setBusy(false)
      void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
      // Chat conversations can create/update goals out-of-band — keep the
      // Profile tab's goal cards and progress curves fresh after a reply.
      void queryClient.invalidateQueries({ queryKey: ['goals'] })
      void queryClient.invalidateQueries({ queryKey: ['goal-progress'] })
      textareaRef.current?.focus()
    } else if (event.kind === 'error') {
      setError(event.message)
      setBusy(false)
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, stream])

  // Grow the composer to fit what's typed (up to the CSS max-height, past which
  // it scrolls internally). Reset to 'auto' first so it can also shrink back.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  async function openSession(id: string): Promise<void> {
    const session = await window.api.chatGetSession(id)
    setActiveId(id)
    setMessages(session?.messages ?? [])
    setMode(DEFAULT_CHAT_MODE) // display-only for a resumed session — mode isn't persisted, and the picker stays hidden here anyway
    setStream([])
    setError(null)
    setBusy(false) // terminal events for a previously-active session are dropped by the stream guard
  }

  function newAnalysis(): void {
    setActiveId(null)
    setMessages([])
    setMode(DEFAULT_CHAT_MODE)
    setStream([])
    setError(null)
    setBusy(false)
  }

  async function send(override?: string): Promise<void> {
    const typedMessage = (override ?? input).trim()
    if ((!typedMessage && attachments.length === 0) || busy) return
    const message = typedMessage || 'Review the attached files.'
    setInput('')
    setError(null)
    setBusy(true)
    setMessages((m) => [...m, { role: 'user', content: message, ts: new Date().toISOString() }])
    try {
      const { sessionId } = await window.api.chatSend(
        activeId,
        message,
        attachments.map(({ path }) => path),
        mode
      )
      setActiveId(sessionId)
      setAttachments([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  function sendSuggestion(prompt: string): void {
    setInput(prompt)
    void send(prompt)
  }

  function addAttachments(incoming: ChatAttachment[]): void {
    if (incoming.length === 0) return
    setAttachments((current) => {
      const currentPaths = new Set(current.map(({ path }) => path))
      const additions = incoming.filter(({ path }) => !currentPaths.has(path))
      if (additions.length === 0) return current
      if (current.length + additions.length > MAX_CHAT_ATTACHMENTS) {
        setError(`You can attach up to ${MAX_CHAT_ATTACHMENTS} files at a time.`)
        return current
      }
      return [...current, ...additions]
    })
  }

  async function pickAttachments(): Promise<void> {
    if (busy || attachments.length >= MAX_CHAT_ATTACHMENTS) return
    setError(null)
    try {
      const picked = await window.api.chatPickAttachments()
      if (picked.length === 0) return
      addAttachments(picked)
      textareaRef.current?.focus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function handleDragEnter(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    if (busy) return
    dragCounterRef.current += 1
    setDragActive(true)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    if (busy) return
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setDragActive(false)
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>): Promise<void> {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounterRef.current = 0
    setDragActive(false)
    if (busy) return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter((p) => p.length > 0)
    if (paths.length === 0) return
    setError(null)
    try {
      const validated = await window.api.chatValidateAttachments(paths)
      addAttachments(validated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function stop(): Promise<void> {
    if (!activeId) return
    await window.api.chatStop(activeId)
  }

  const sessions = sessionsQuery.data ?? []
  const status = statusQuery.data
  const offline = useMemo(() => status !== undefined && !status.available, [status])

  if (offline) {
    return (
      <div className="view">
        <TabHeader eyebrow="Analysis chat" title="Chat" />
        <div className="chat-offline">
          <p>
            Claude Code isn&apos;t reachable — the chat drives the locally installed{' '}
            <code>claude</code> CLI (subscription auth, no API key). Install or sign in, then retry.
          </p>
          <ButtonSoft onClick={() => void statusQuery.refetch()}>Retry connection</ButtonSoft>
          {sessions.length > 0 && (
            <div className="chat-offline-history">
              {sessions.map((s) => (
                <div key={s.id} className="chat-session-row chat-session-row--static">
                  <span>{s.title ?? 'Untitled analysis'}</span>
                  <span className="chat-session-date">
                    {new Date(s.started_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="view chat-view">
      <TabHeader eyebrow="Analysis chat" title="Chat" />
      <div className="chat-layout">
        <aside className="chat-sessions">
          <button className="chat-new-btn" onClick={newAnalysis}>
            <Plus size={16} strokeWidth={1.5} /> New analysis
          </button>
          <div className="chat-session-list">
            {sessions.length === 0 ? (
              <p className="chat-session-empty">No conversations yet</p>
            ) : (
              sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  onOpen={() => void openSession(s.id)}
                  onRenamed={() =>
                    void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
                  }
                  onDeleted={() => {
                    void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
                    if (s.id === activeId) newAnalysis()
                  }}
                />
              ))
            )}
          </div>
        </aside>

        <div
          className="chat-panel"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(e) => void handleDrop(e)}
        >
          {dragActive && (
            <div className="chat-drop-overlay">
              <Paperclip size={16} strokeWidth={1.6} aria-hidden="true" />
              Drop files to attach
            </div>
          )}
          <div className="chat-messages" ref={scrollRef}>
            <div className="chat-thread">
              {messages.length === 0 && stream.length === 0 && (
                <div className="chat-empty">
                  <span className="chat-empty-mark" aria-hidden="true">
                    <Activity size={22} strokeWidth={1.75} />
                  </span>
                  <h2 className="chat-empty-title">What do you want to understand?</h2>
                  <p className="chat-empty-sub">
                    Ask about your training, recovery, or trends. Every answer is computed live
                    from your own data.
                  </p>
                  <div className="chat-suggestions">
                    {SUGGESTED_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        className="chip chat-suggestion-chip"
                        onClick={() => sendSuggestion(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="chat-turn chat-turn--user">
                    <div className="chat-user-bubble">{m.content}</div>
                  </div>
                ) : (
                  <div key={i} className="chat-turn chat-turn--assistant">
                    <span className="chat-avatar" aria-hidden="true">
                      <Activity size={15} strokeWidth={2} />
                    </span>
                    <div className="chat-assistant-block">
                      <CopyButton text={m.content} />
                      <div className="chat-assistant">
                        <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
                      </div>
                    </div>
                  </div>
                )
              )}

              {stream.length > 0 && (
                <div className="chat-turn chat-turn--assistant">
                  <span className="chat-avatar" aria-hidden="true">
                    <Activity size={15} strokeWidth={2} />
                  </span>
                  <div className="chat-stream">
                    {stream.map((b, i) =>
                      b.kind === 'tool' ? (
                        <ToolLine key={`s${i}`} name={b.name ?? 'tool'} detail={b.text} />
                      ) : (
                        <div key={`s${i}`} className="chat-assistant">
                          <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              {busy && stream.length === 0 && (
                <div className="chat-turn chat-turn--assistant">
                  <span className="chat-avatar chat-avatar--pulsing" aria-hidden="true">
                    <Activity size={15} strokeWidth={2} />
                  </span>
                  <div className="chat-thinking">Analyzing your data…</div>
                </div>
              )}

              {error && <div className="chat-error">{error}</div>}
            </div>
          </div>

          <div className="chat-composer">
            {isComposingNewChat(activeId, messages) && (
              <div className="chat-mode-picker" role="tablist" aria-label="Chat mode">
                {CHAT_MODES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={option === mode}
                    className={
                      option === mode ? 'chat-mode-chip chat-mode-chip--active' : 'chat-mode-chip'
                    }
                    onClick={() => setMode(option)}
                  >
                    {CHAT_MODE_LABELS[option]}
                  </button>
                ))}
              </div>
            )}
            <div className="chat-input-well">
              {attachments.length > 0 && (
                <div className="chat-attachments" aria-label="Attached files">
                  {attachments.map((attachment) => (
                    <span
                      className="chat-attachment-chip"
                      key={attachment.path}
                      title={attachment.path}
                    >
                      <Paperclip size={13} strokeWidth={1.7} aria-hidden="true" />
                      <span className="chat-attachment-name">{attachment.name}</span>
                      <button
                        type="button"
                        className="chat-attachment-remove"
                        onClick={() =>
                          setAttachments((current) =>
                            current.filter(({ path }) => path !== attachment.path)
                          )
                        }
                        disabled={busy}
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="chat-input-row">
                <button
                  type="button"
                  className="chat-attach-btn"
                  onClick={() => void pickAttachments()}
                  disabled={busy || attachments.length >= MAX_CHAT_ATTACHMENTS}
                  aria-label={`Attach files (${attachments.length} of ${MAX_CHAT_ATTACHMENTS})`}
                  title="Attach files"
                >
                  <Paperclip size={18} strokeWidth={1.6} />
                </button>
                <textarea
                  ref={textareaRef}
                  className="chat-input"
                  rows={1}
                  placeholder="Ask about your training, recovery, trends…"
                  value={input}
                  disabled={busy}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                {busy ? (
                  <button
                    className="chat-send chat-stop"
                    onClick={() => void stop()}
                    aria-label="Stop"
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="chat-send"
                    onClick={() => void send()}
                    disabled={!input.trim() && attachments.length === 0}
                    aria-label="Send"
                  >
                    <ArrowUp size={18} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SessionRow({
  session,
  active,
  onOpen,
  onRenamed,
  onDeleted
}: {
  session: ChatSessionMeta
  active: boolean
  onOpen: () => void
  onRenamed: () => void
  onDeleted: () => void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  function startEditing(e: MouseEvent): void {
    e.stopPropagation()
    setDraft(session.title ?? '')
    setEditing(true)
  }

  async function saveEdit(): Promise<void> {
    const title = draft.trim()
    setEditing(false)
    if (!title || title === (session.title ?? '')) return
    await window.api.chatRename(session.id, title)
    onRenamed()
  }

  function handleDeleteClick(e: MouseEvent): void {
    e.stopPropagation()
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
      <div className="chat-session-row chat-session-row--editing">
        <input
          ref={inputRef}
          className="chat-session-edit-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void saveEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
          }}
          onBlur={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    <button
      className={active ? 'chat-session-row chat-session-row--active' : 'chat-session-row'}
      onClick={onOpen}
    >
      <span className="chat-session-row-top">
        {active && <span className="chat-session-active-dot" aria-hidden="true" />}
        <span className="chat-session-title">{session.title ?? 'Untitled analysis'}</span>
        <span className="chat-session-actions">
          <span
            className="chat-session-icon-btn"
            role="button"
            tabIndex={0}
            aria-label="Rename"
            onClick={startEditing}
          >
            <Pencil size={14} strokeWidth={1.5} />
          </span>
          <span
            className={
              confirmingDelete
                ? 'chat-session-icon-btn chat-session-icon-btn--confirm'
                : 'chat-session-icon-btn'
            }
            role="button"
            tabIndex={0}
            aria-label="Delete"
            title={confirmingDelete ? 'Click again to delete' : undefined}
            onClick={handleDeleteClick}
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </span>
        </span>
      </span>
      <span className="chat-session-date">{new Date(session.started_at).toLocaleDateString()}</span>
    </button>
  )
}

function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="chat-copy-btn"
      aria-label="Copy message"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
    </button>
  )
}

function ToolLine({ name, detail }: { name: string; detail: string }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="chat-tool">
      <button className="chat-tool-toggle" onClick={() => setOpen((v) => !v)}>
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={open ? 'chat-tool-chevron chat-tool-chevron--open' : 'chat-tool-chevron'}
        />
        ran {name.toLowerCase()}…
      </button>
      {open && <pre className="chat-tool-detail">{detail}</pre>}
    </div>
  )
}
