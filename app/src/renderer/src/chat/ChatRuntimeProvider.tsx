import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ChatAttachment, ChatMode, ChatRuntimeSnapshot } from '@shared/types'
import {
  CHAT_UI_STORAGE_KEY,
  NEW_CHAT_KEY,
  chatUiReducer,
  parseChatUiSnapshot,
  serializeChatUiState,
  type ChatUiState
} from './chatUiState'

export function isChatRuntimeActive(runtime: ChatRuntimeSnapshot | null): boolean {
  return Boolean(runtime && ['starting', 'running', 'stopping'].includes(runtime.phase))
}

export interface ChatRuntimeContextValue {
  state: ChatUiState
  selectedKey: string
  draft: string
  mode: ChatMode
  attachments: ChatAttachment[]
  sending: boolean
  selectSession(sessionId: string): void
  newAnalysis(): void
  setDraft(text: string): void
  setMode(mode: ChatMode): void
  setAttachments(attachments: ChatAttachment[]): void
  send(override?: string): Promise<void>
  stop(sessionId?: string): Promise<void>
  continueInterrupted(): Promise<void>
  removeSession(sessionId: string): void
  setHistoryOpen(open: boolean): void
  setWorkLogOpen(open: boolean): void
  setNotice(notice: string | null): void
  clearNotice(): void
}

const ChatRuntimeContext = createContext<ChatRuntimeContextValue | null>(null)

function loadInitialState(): ChatUiState {
  try {
    return parseChatUiSnapshot(localStorage.getItem(CHAT_UI_STORAGE_KEY))
  } catch {
    return parseChatUiSnapshot(null)
  }
}

function persistState(state: ChatUiState): void {
  try {
    localStorage.setItem(CHAT_UI_STORAGE_KEY, serializeChatUiState(state))
  } catch {
    // The provider remains fully functional for the current app process.
  }
}

export function ChatRuntimeProvider({ children }: PropsWithChildren): ReactElement {
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(chatUiReducer, undefined, loadInitialState)
  const [sending, setSending] = useState(false)
  const validatedRestoredAttachments = useRef(false)

  const refreshRuntime = useCallback(async (): Promise<void> => {
    const current = await window.api.chatGetRuntime()
    dispatch({ type: 'hydrate-runtime', runtime: current })
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onChatStream((envelope) => {
      dispatch({ type: 'runtime-event', envelope })
      if (envelope.event.kind === 'done' || envelope.event.kind === 'error') {
        void refreshRuntime()
        void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
        void queryClient.invalidateQueries({ queryKey: ['chat', 'session', envelope.sessionId] })
        void queryClient.invalidateQueries({ queryKey: ['goals'] })
        void queryClient.invalidateQueries({ queryKey: ['goal-progress'] })
      }
    })
    void refreshRuntime()
    return unsubscribe
  }, [queryClient, refreshRuntime])

  useEffect(() => {
    persistState(state)
  }, [state])

  useEffect(() => {
    if (validatedRestoredAttachments.current) return
    validatedRestoredAttachments.current = true
    const entries = Object.entries(state.attachments).filter(
      ([, attachments]) => attachments.length
    )
    if (!entries.length) return

    void (async () => {
      let removed = 0
      for (const [key, attachments] of entries) {
        const results = await Promise.allSettled(
          attachments.map(({ path }) => window.api.chatValidateAttachments([path]))
        )
        const valid = results.flatMap((result) =>
          result.status === 'fulfilled' ? result.value : []
        )
        removed += attachments.length - valid.length
        dispatch({ type: 'set-attachments', key, attachments: valid })
      }
      if (removed > 0) {
        dispatch({
          type: 'set-notice',
          notice: `${removed} restored attachment${removed === 1 ? '' : 's'} could no longer be found.`
        })
      }
    })()
    // Restore validation intentionally runs once against the hydrated local snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedKey = state.selectedSessionId ?? NEW_CHAT_KEY
  const draft = state.drafts[selectedKey] ?? ''
  const mode = state.modes[selectedKey] ?? 'analysis'
  const attachments = state.attachments[selectedKey] ?? []

  const selectSession = useCallback((sessionId: string): void => {
    dispatch({ type: 'select', sessionId })
  }, [])

  const newAnalysis = useCallback((): void => {
    dispatch({ type: 'new-chat' })
  }, [])

  const setDraft = useCallback(
    (text: string): void => dispatch({ type: 'set-draft', key: selectedKey, text }),
    [selectedKey]
  )

  const setMode = useCallback(
    (nextMode: ChatMode): void => dispatch({ type: 'set-mode', key: selectedKey, mode: nextMode }),
    [selectedKey]
  )

  const setAttachments = useCallback(
    (nextAttachments: ChatAttachment[]): void =>
      dispatch({ type: 'set-attachments', key: selectedKey, attachments: nextAttachments }),
    [selectedKey]
  )

  const removeSession = useCallback(
    (sessionId: string): void => dispatch({ type: 'remove-session', sessionId }),
    []
  )
  const setHistoryOpen = useCallback(
    (open: boolean): void => dispatch({ type: 'set-history-open', open }),
    []
  )
  const setWorkLogOpen = useCallback(
    (open: boolean): void => dispatch({ type: 'set-work-log-open', open }),
    []
  )
  const setNotice = useCallback(
    (notice: string | null): void => dispatch({ type: 'set-notice', notice }),
    []
  )
  const clearNotice = useCallback((): void => dispatch({ type: 'set-notice', notice: null }), [])

  const send = useCallback(
    async (override?: string): Promise<void> => {
      if (sending || isChatRuntimeActive(state.runtime)) return
      const typedMessage = (override ?? draft).trim()
      if (!typedMessage && attachments.length === 0) return
      const message = typedMessage || 'Review the attached files.'

      setSending(true)
      dispatch({ type: 'set-notice', notice: null })
      try {
        const result = await window.api.chatSend(
          state.selectedSessionId,
          message,
          attachments.map(({ path }) => path),
          mode
        )
        dispatch({
          type: 'promote-composition',
          fromKey: selectedKey,
          sessionId: result.sessionId
        })
        await refreshRuntime()
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] }),
          queryClient.invalidateQueries({ queryKey: ['chat', 'session', result.sessionId] })
        ])
      } catch (error) {
        dispatch({
          type: 'set-notice',
          notice: error instanceof Error ? error.message : String(error)
        })
      } finally {
        setSending(false)
      }
    },
    [
      attachments,
      draft,
      mode,
      queryClient,
      refreshRuntime,
      selectedKey,
      sending,
      state.runtime,
      state.selectedSessionId
    ]
  )

  const stop = useCallback(
    async (sessionId?: string): Promise<void> => {
      const target = sessionId ?? state.runtime?.sessionId
      if (!target || !isChatRuntimeActive(state.runtime)) return
      await window.api.chatStop(target)
    },
    [state.runtime]
  )

  const continueInterrupted = useCallback(async (): Promise<void> => {
    if (sending || state.runtime?.phase !== 'interrupted') return
    setSending(true)
    dispatch({ type: 'set-notice', notice: null })
    try {
      const result = await window.api.chatContinue(state.runtime.sessionId)
      dispatch({ type: 'select', sessionId: result.sessionId })
      await refreshRuntime()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['chat', 'session', result.sessionId] })
      ])
    } catch (error) {
      dispatch({
        type: 'set-notice',
        notice: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setSending(false)
    }
  }, [queryClient, refreshRuntime, sending, state.runtime])

  const value = useMemo<ChatRuntimeContextValue>(
    () => ({
      state,
      selectedKey,
      draft,
      mode,
      attachments,
      sending,
      selectSession,
      newAnalysis,
      setDraft,
      setMode,
      setAttachments,
      send,
      stop,
      continueInterrupted,
      removeSession,
      setHistoryOpen,
      setWorkLogOpen,
      setNotice,
      clearNotice
    }),
    [
      attachments,
      clearNotice,
      continueInterrupted,
      draft,
      mode,
      newAnalysis,
      removeSession,
      selectSession,
      selectedKey,
      send,
      sending,
      setAttachments,
      setDraft,
      setHistoryOpen,
      setMode,
      setNotice,
      setWorkLogOpen,
      state,
      stop
    ]
  )

  return <ChatRuntimeContext.Provider value={value}>{children}</ChatRuntimeContext.Provider>
}

export function useChatRuntime(): ChatRuntimeContextValue {
  const context = useContext(ChatRuntimeContext)
  if (!context) throw new Error('useChatRuntime must be used within ChatRuntimeProvider')
  return context
}
