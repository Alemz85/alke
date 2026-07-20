import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, History, ListTree, RotateCcw } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ChatRuntimeSnapshot } from '@shared/types'
import { isChatRuntimeActive, useChatRuntime } from '../chat/ChatRuntimeProvider'
import { ChatComposer } from './chat/ChatComposer'
import { ChatHistory } from './chat/ChatHistory'
import { ChatWorkLog, ChatWorkLogSummary } from './chat/ChatWorkLog'
import './ChatView.css'

const SUGGESTED_PROMPTS = [
  'Summarize the last two weeks and show the evidence behind each conclusion',
  'Is my swim efficiency improving, and what makes you confident?',
  'Design next week around my current training load and recovery'
]

const MODE_LABELS = {
  analysis: 'Analysis',
  injuries: 'Injuries',
  goals: 'Goals'
} as const

export function ChatView(): ReactElement {
  const queryClient = useQueryClient()
  const {
    state,
    mode,
    sending,
    selectSession,
    newAnalysis,
    send,
    stop,
    continueInterrupted,
    removeSession,
    setHistoryOpen,
    setWorkLogOpen,
    clearNotice
  } = useChatRuntime()
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const workLogTriggerRef = useRef<HTMLButtonElement>(null)
  const followOutput = useRef(true)

  const statusQuery = useQuery({
    queryKey: ['chat', 'status'],
    queryFn: () => window.api.chatStatus()
  })
  const sessionsQuery = useQuery({
    queryKey: ['chat', 'sessions'],
    queryFn: () => window.api.chatListSessions()
  })
  const selectedSessionQuery = useQuery({
    queryKey: ['chat', 'session', state.selectedSessionId],
    queryFn: () =>
      state.selectedSessionId
        ? window.api.chatGetSession(state.selectedSessionId)
        : Promise.resolve(null),
    enabled: state.selectedSessionId !== null
  })

  const sessions = sessionsQuery.data ?? []
  const messages = selectedSessionQuery.data?.messages ?? []
  const runtime = state.runtime
  const runtimeBelongsHere = Boolean(runtime && runtime.sessionId === state.selectedSessionId)
  const runtimeActive = isChatRuntimeActive(runtime)
  const selectedMeta = sessions.find(({ id }) => id === state.selectedSessionId)
  const offline = statusQuery.data?.available === false
  const terminalRuntime = Boolean(
    runtime && ['completed', 'failed', 'interrupted'].includes(runtime.phase)
  )
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const runtimeAlreadyPersisted = Boolean(
    runtimeBelongsHere &&
    terminalRuntime &&
    runtime?.assistantText &&
    lastAssistant?.content === runtime.assistantText
  )
  const showRuntimeAnswer = Boolean(
    runtimeBelongsHere && runtime?.assistantText && !runtimeAlreadyPersisted
  )
  const showRuntimeTurn = Boolean(
    runtimeBelongsHere &&
    (showRuntimeAnswer ||
      runtimeActive ||
      runtime?.phase === 'interrupted' ||
      runtime?.phase === 'failed')
  )

  const statusLabel = useMemo(() => {
    if (sending) return 'Starting'
    if (!runtime) return offline ? 'Offline' : 'Ready'
    if (!runtimeBelongsHere && runtimeActive) return 'Working elsewhere'
    const labels: Record<ChatRuntimeSnapshot['phase'], string> = {
      starting: 'Starting',
      running: 'Working',
      stopping: 'Stopping',
      completed: 'Complete',
      failed: 'Needs attention',
      interrupted: 'Interrupted'
    }
    return runtimeBelongsHere ? labels[runtime.phase] : offline ? 'Offline' : 'Ready'
  }, [offline, runtime, runtimeActive, runtimeBelongsHere, sending])

  useEffect(() => {
    followOutput.current = true
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    })
  }, [state.selectedSessionId])

  useEffect(() => {
    if (!followOutput.current) return
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    })
  }, [messages.length, runtime?.assistantText, runtime?.lastSequence])

  const closeHistory = (): void => {
    setHistoryOpen(false)
    historyTriggerRef.current?.focus()
  }
  const closeWorkLog = (): void => {
    setWorkLogOpen(false)
    workLogTriggerRef.current?.focus()
  }
  const invalidateSessions = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
  }

  return (
    <section className="view chat-view" aria-label="Analysis chat">
      <div
        className={`chat-workspace${
          state.workLogOpen && runtimeBelongsHere ? ' chat-workspace--log-open' : ''
        }`}
      >
        <ChatHistory
          sessions={sessions}
          selectedId={state.selectedSessionId}
          runtime={runtime}
          open={state.historyOpen}
          onClose={closeHistory}
          onNew={() => {
            newAnalysis()
            closeHistory()
          }}
          onSelect={selectSession}
          onRenamed={invalidateSessions}
          onDeleted={(sessionId) => {
            removeSession(sessionId)
            invalidateSessions()
          }}
          onStop={(sessionId) => void stop(sessionId)}
        />

        {(state.historyOpen || state.workLogOpen) && (
          <button
            type="button"
            className="chat-drawer-scrim"
            onClick={() => {
              closeHistory()
              closeWorkLog()
            }}
            aria-label="Close open chat panel"
          />
        )}

        <div className="chat-main">
          <header className="chat-session-header">
            <button
              ref={historyTriggerRef}
              type="button"
              className="chat-icon-button chat-history-toggle"
              onClick={() => setHistoryOpen(true)}
              aria-label="Open conversation history"
              aria-expanded={state.historyOpen}
              aria-controls="chat-history"
              title="Conversation history"
            >
              <History size={17} strokeWidth={1.6} aria-hidden="true" />
            </button>
            <div className="chat-session-heading">
              <span className="chat-session-eyebrow">Analysis chat</span>
              <h1>{selectedMeta?.title ?? 'New analysis'}</h1>
            </div>
            <div className="chat-session-meta" aria-label="Conversation status">
              <span>
                {runtimeBelongsHere ? MODE_LABELS[runtime?.mode ?? mode] : MODE_LABELS[mode]}
              </span>
              <span aria-hidden="true">·</span>
              <span className={runtimeActive && runtimeBelongsHere ? 'is-working' : undefined}>
                {statusLabel}
              </span>
            </div>
            {runtimeBelongsHere && runtime && (
              <button
                ref={workLogTriggerRef}
                type="button"
                className="chat-icon-button chat-worklog-toggle"
                onClick={() => setWorkLogOpen(!state.workLogOpen)}
                aria-label={state.workLogOpen ? 'Close work log' : 'Open work log'}
                aria-expanded={state.workLogOpen}
                aria-controls="chat-worklog"
                title="Work log"
              >
                <ListTree size={17} strokeWidth={1.6} aria-hidden="true" />
              </button>
            )}
          </header>

          <div
            ref={scrollRef}
            className="chat-document"
            onScroll={(event) => {
              const element = event.currentTarget
              followOutput.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 120
            }}
          >
            <div className="chat-document-column">
              {selectedSessionQuery.isLoading ? (
                <ConversationSkeleton />
              ) : messages.length === 0 && !showRuntimeTurn ? (
                offline ? (
                  <OfflineState onRetry={() => void statusQuery.refetch()} />
                ) : (
                  <EmptyState onSelect={(prompt) => void send(prompt)} />
                )
              ) : (
                <div className="chat-thread">
                  {messages.map((message, index) => (
                    <MessageTurn key={`${message.ts}-${index}`} message={message} />
                  ))}
                  {showRuntimeTurn && runtime && (
                    <RuntimeTurn
                      runtime={runtime}
                      showAnswer={showRuntimeAnswer}
                      onOpenWorkLog={() => setWorkLogOpen(true)}
                      onContinue={() => void continueInterrupted()}
                    />
                  )}
                </div>
              )}

              {state.notice && (
                <div className="chat-error" role="alert">
                  <span>{state.notice}</span>
                  <button type="button" onClick={clearNotice}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>

          <ChatComposer offline={offline} />
          <p className="chat-sr-only" aria-live="polite">
            {statusLabel}
          </p>
        </div>

        {runtimeBelongsHere && runtime && (
          <ChatWorkLog
            runtime={runtime}
            open={state.workLogOpen}
            onOpen={() => setWorkLogOpen(true)}
            onClose={closeWorkLog}
          />
        )}
      </div>
    </section>
  )
}

function MessageTurn({ message }: { message: ChatMessage }): ReactElement {
  if (message.role === 'user') {
    return (
      <article className="chat-turn chat-turn--user">
        <div className="chat-user-bubble">
          <p>{message.content}</p>
          {message.attachments && message.attachments.length > 0 && (
            <ul className="chat-message-attachments" aria-label="Message attachments">
              {message.attachments.map((attachment) => (
                <li key={attachment.path}>{attachment.name}</li>
              ))}
            </ul>
          )}
        </div>
      </article>
    )
  }

  return (
    <article className="chat-turn chat-turn--assistant">
      <div className="chat-turn-meta">
        <span>Alke</span>
        <time dateTime={message.ts}>{formatMessageTime(message.ts)}</time>
      </div>
      <div className="chat-assistant-block">
        <CopyButton text={message.content} />
        <AssistantDocument text={message.content} />
      </div>
    </article>
  )
}

function RuntimeTurn({
  runtime,
  showAnswer,
  onOpenWorkLog,
  onContinue
}: {
  runtime: ChatRuntimeSnapshot
  showAnswer: boolean
  onOpenWorkLog(): void
  onContinue(): void
}): ReactElement {
  return (
    <article className="chat-turn chat-turn--assistant chat-turn--runtime">
      <div className="chat-turn-meta">
        <span>Alke</span>
        <span>{runtime.phase === 'running' ? 'Writing' : runtime.phase}</span>
      </div>
      <div className="chat-assistant-block">
        {showAnswer && <CopyButton text={runtime.assistantText} />}
        {showAnswer ? (
          <AssistantDocument text={runtime.assistantText} />
        ) : isChatRuntimeActive(runtime) ? (
          <p className="chat-runtime-status">Working through your data…</p>
        ) : null}
        <ChatWorkLogSummary runtime={runtime} onOpen={onOpenWorkLog} />
        {runtime.phase === 'interrupted' && (
          <div className="chat-interrupted">
            <div>
              <strong>Response interrupted</strong>
              <p>The partial answer and completed work are preserved.</p>
            </div>
            <button type="button" onClick={onContinue}>
              <RotateCcw size={14} strokeWidth={1.7} aria-hidden="true" />
              {runtime.resumeAvailable ? 'Continue' : 'Retry'}
            </button>
          </div>
        )}
        {runtime.phase === 'failed' && runtime.error && (
          <div className="chat-runtime-error" role="alert">
            {runtime.error}
          </div>
        )}
      </div>
    </article>
  )
}

function AssistantDocument({ text }: { text: string }): ReactElement {
  return (
    <div className="chat-assistant-document">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children, ...props }) => (
            <div className="chat-table-scroll" tabIndex={0} aria-label="Scrollable table">
              <table {...props}>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}

function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return (
    <button
      type="button"
      className="chat-copy-button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        })
      }}
      aria-label={copied ? 'Copied response' : 'Copy response'}
      title={copied ? 'Copied' : 'Copy response'}
    >
      {copied ? (
        <Check size={14} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <Copy size={14} strokeWidth={1.6} aria-hidden="true" />
      )}
    </button>
  )
}

function EmptyState({ onSelect }: { onSelect(prompt: string): void }): ReactElement {
  return (
    <div className="chat-empty">
      <span className="chat-session-eyebrow">Personal analysis workspace</span>
      <h2>Start with a question worth keeping.</h2>
      <p>
        Alke can inspect your private health history and complete local repository work outside the
        app itself. Answers stay grounded in the underlying data.
      </p>
      <div className="chat-suggestions">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onSelect(prompt)}>
            <span>{prompt}</span>
            <span aria-hidden="true">↗</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function OfflineState({ onRetry }: { onRetry(): void }): ReactElement {
  return (
    <div className="chat-empty chat-offline">
      <span className="chat-session-eyebrow">Connection</span>
      <h2>Claude Code is offline.</h2>
      <p>
        Past conversations remain available. Install or sign in to the local Claude CLI to continue.
      </p>
      <button type="button" className="chat-secondary-button" onClick={onRetry}>
        Retry connection
      </button>
    </div>
  )
}

function ConversationSkeleton(): ReactElement {
  return (
    <div className="chat-skeleton" aria-label="Loading conversation">
      <span />
      <span />
      <span />
    </div>
  )
}

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
