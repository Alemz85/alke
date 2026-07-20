import { useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react'
import { ArrowUp, Paperclip, Square, X } from 'lucide-react'
import { CHAT_MODES, MAX_CHAT_ATTACHMENTS, type ChatAttachment } from '@shared/types'
import { isChatRuntimeActive, useChatRuntime } from '../../chat/ChatRuntimeProvider'

const MODE_LABELS = {
  analysis: 'Analysis',
  injuries: 'Injuries',
  goals: 'Goals'
} as const

export function ChatComposer({ offline = false }: { offline?: boolean }): ReactElement {
  const {
    state,
    draft,
    mode,
    attachments,
    sending,
    setDraft,
    setMode,
    setAttachments,
    setNotice,
    send,
    stop
  } = useChatRuntime()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const runtimeActive = isChatRuntimeActive(state.runtime)
  const runningHere = runtimeActive && state.runtime?.sessionId === state.selectedSessionId
  const blockedByOtherRun = runtimeActive && state.runtime?.sessionId !== state.selectedSessionId
  const canSend =
    !offline && !sending && !runtimeActive && Boolean(draft.trim() || attachments.length)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [draft])

  const addAttachments = (incoming: ChatAttachment[]): void => {
    const currentPaths = new Set(attachments.map(({ path }) => path))
    const additions = incoming.filter(({ path }) => !currentPaths.has(path))
    if (attachments.length + additions.length > MAX_CHAT_ATTACHMENTS) {
      setNotice(`You can attach up to ${MAX_CHAT_ATTACHMENTS} files at a time.`)
      return
    }
    setAttachments([...attachments, ...additions])
  }

  const pickAttachments = async (): Promise<void> => {
    try {
      const picked = await window.api.chatPickAttachments()
      addAttachments(picked)
      textareaRef.current?.focus()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const handleDragEnter = (event: DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const handleDragLeave = (event: DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const handleDrop = async (event: DragEvent<HTMLFormElement>): Promise<void> => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.api.getPathForFile(file))
      .filter(Boolean)
    if (!paths.length) return
    try {
      addAttachments(await window.api.chatValidateAttachments(paths))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <form
      className={`chat-composer${dragging ? ' is-dragging' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend) void send()
      }}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      {dragging && (
        <div className="chat-composer-drop" aria-hidden="true">
          Drop files to attach
        </div>
      )}
      <div className="chat-composer-column">
        {state.selectedSessionId === null && (
          <div className="chat-mode-picker" role="tablist" aria-label="Analysis mode">
            {CHAT_MODES.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={option === mode}
                className={`chat-mode-button${option === mode ? ' is-selected' : ''}`}
                onClick={() => setMode(option)}
              >
                {MODE_LABELS[option]}
              </button>
            ))}
          </div>
        )}
        <div className="chat-input-well">
          {attachments.length > 0 && (
            <div className="chat-attachments" aria-label="Attached files">
              {attachments.map((attachment) => (
                <span className="chat-attachment" key={attachment.path} title={attachment.path}>
                  <Paperclip size={12} strokeWidth={1.6} aria-hidden="true" />
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments(attachments.filter(({ path }) => path !== attachment.path))
                    }
                    aria-label={`Remove ${attachment.name}`}
                    title={`Remove ${attachment.name}`}
                  >
                    <X size={12} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="chat-input-row">
            <button
              type="button"
              className="chat-attach-button"
              onClick={() => void pickAttachments()}
              disabled={attachments.length >= MAX_CHAT_ATTACHMENTS}
              aria-label={`Attach files (${attachments.length} of ${MAX_CHAT_ATTACHMENTS})`}
              title="Attach files"
            >
              <Paperclip size={18} strokeWidth={1.6} aria-hidden="true" />
            </button>
            <textarea
              ref={textareaRef}
              className="chat-input"
              name="chat-message"
              autoComplete="off"
              rows={1}
              value={draft}
              placeholder="Ask about your training, recovery, or trends…"
              aria-label="Message Alke"
              aria-describedby="chat-composer-hint"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (canSend) void send()
                }
              }}
            />
            {runningHere ? (
              <button
                type="button"
                className="chat-send-button is-stop"
                onClick={() => void stop()}
                aria-label="Stop response"
                title="Stop response"
              >
                <Square size={13} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="chat-send-button"
                disabled={!canSend}
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <div id="chat-composer-hint" className="chat-composer-hint">
          <span>
            {offline
              ? 'Claude Code is offline'
              : blockedByOtherRun
                ? 'A response is running in another conversation'
                : sending
                  ? 'Starting response'
                  : 'Enter to send · Shift+Enter for a new line'}
          </span>
          <span>
            {attachments.length}/{MAX_CHAT_ATTACHMENTS} files
          </span>
        </div>
      </div>
    </form>
  )
}
