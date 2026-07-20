import type {
  ChatAttachment,
  ChatMode,
  ChatRuntimeEnvelope,
  ChatRuntimeSnapshot,
  ChatWorkLogEntry
} from '@shared/types'

export const CHAT_UI_STORAGE_KEY = 'alke-chat-ui:v1'
export const NEW_CHAT_KEY = '__new__'

const CHAT_UI_VERSION = 1
const MAX_SAVED_COMPOSITIONS = 50
const MAX_SAVED_DRAFT_LENGTH = 100_000
const MODES = new Set<ChatMode>(['analysis', 'injuries', 'goals'])

export interface ChatUiState {
  version: 1
  selectedSessionId: string | null
  drafts: Record<string, string>
  modes: Record<string, ChatMode>
  attachments: Record<string, ChatAttachment[]>
  runtime: ChatRuntimeSnapshot | null
  historyOpen: boolean
  workLogOpen: boolean
  notice: string | null
}

export type ChatUiAction =
  | { type: 'select'; sessionId: string | null }
  | { type: 'new-chat' }
  | { type: 'set-draft'; key: string; text: string }
  | { type: 'set-mode'; key: string; mode: ChatMode }
  | { type: 'set-attachments'; key: string; attachments: ChatAttachment[] }
  | { type: 'promote-composition'; fromKey: string; sessionId: string }
  | { type: 'remove-session'; sessionId: string }
  | { type: 'hydrate-runtime'; runtime: ChatRuntimeSnapshot | null }
  | { type: 'runtime-event'; envelope: ChatRuntimeEnvelope }
  | { type: 'set-history-open'; open: boolean }
  | { type: 'set-work-log-open'; open: boolean }
  | { type: 'set-notice'; notice: string | null }

interface PersistedChatUiState {
  version: 1
  selectedSessionId: string | null
  drafts: Record<string, string>
  modes: Record<string, ChatMode>
  attachments: Record<string, ChatAttachment[]>
  historyOpen: boolean
  workLogOpen: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAttachment(value: unknown): value is ChatAttachment {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.name === 'string' &&
    typeof value.sizeBytes === 'number' &&
    Number.isFinite(value.sizeBytes) &&
    value.sizeBytes >= 0
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= MAX_SAVED_COMPOSITIONS &&
    Object.entries(value).every(
      ([key, entry]) =>
        key.length > 0 && typeof entry === 'string' && entry.length <= MAX_SAVED_DRAFT_LENGTH
    )
  )
}

function isModeRecord(value: unknown): value is Record<string, ChatMode> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= MAX_SAVED_COMPOSITIONS &&
    Object.values(value).every((entry) => MODES.has(entry as ChatMode))
  )
}

function isAttachmentRecord(value: unknown): value is Record<string, ChatAttachment[]> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= MAX_SAVED_COMPOSITIONS &&
    Object.values(value).every(
      (entry) => Array.isArray(entry) && entry.length <= 8 && entry.every(isAttachment)
    )
  )
}

export function initialChatUiState(): ChatUiState {
  return {
    version: CHAT_UI_VERSION,
    selectedSessionId: null,
    drafts: { [NEW_CHAT_KEY]: '' },
    modes: { [NEW_CHAT_KEY]: 'analysis' },
    attachments: { [NEW_CHAT_KEY]: [] },
    runtime: null,
    historyOpen: false,
    workLogOpen: false,
    notice: null
  }
}

export function parseChatUiSnapshot(serialized: string | null): ChatUiState {
  if (!serialized) return initialChatUiState()
  try {
    const value = JSON.parse(serialized) as unknown
    if (
      !isRecord(value) ||
      value.version !== CHAT_UI_VERSION ||
      (value.selectedSessionId !== null && typeof value.selectedSessionId !== 'string') ||
      !isStringRecord(value.drafts) ||
      !isModeRecord(value.modes) ||
      !isAttachmentRecord(value.attachments) ||
      typeof value.historyOpen !== 'boolean' ||
      typeof value.workLogOpen !== 'boolean'
    ) {
      return initialChatUiState()
    }

    return {
      version: CHAT_UI_VERSION,
      selectedSessionId: value.selectedSessionId,
      drafts: { [NEW_CHAT_KEY]: '', ...value.drafts },
      modes: { [NEW_CHAT_KEY]: 'analysis', ...value.modes },
      attachments: { [NEW_CHAT_KEY]: [], ...value.attachments },
      runtime: null,
      historyOpen: value.historyOpen,
      workLogOpen: value.workLogOpen,
      notice: null
    }
  } catch {
    return initialChatUiState()
  }
}

export function serializeChatUiState(state: ChatUiState): string {
  const persisted: PersistedChatUiState = {
    version: CHAT_UI_VERSION,
    selectedSessionId: state.selectedSessionId,
    drafts: state.drafts,
    modes: state.modes,
    attachments: state.attachments,
    historyOpen: state.historyOpen,
    workLogOpen: state.workLogOpen
  }
  return JSON.stringify(persisted)
}

function runtimeFromEnvelope(
  runtime: ChatRuntimeSnapshot,
  envelope: ChatRuntimeEnvelope
): ChatRuntimeSnapshot {
  const event = envelope.event
  const next: ChatRuntimeSnapshot = {
    ...runtime,
    updatedAt: new Date().toISOString(),
    lastSequence: envelope.sequence
  }

  if (event.kind === 'text') {
    next.assistantText += event.text
    if (next.phase === 'starting') next.phase = 'running'
  } else if (event.kind === 'tool' || event.kind === 'status') {
    const entry: ChatWorkLogEntry = {
      sequence: envelope.sequence,
      at: next.updatedAt,
      kind: event.kind,
      label: event.kind === 'tool' ? event.name : event.label,
      detail: event.kind === 'tool' ? event.detail : (event.detail ?? '')
    }
    next.workLog = [...next.workLog, entry].slice(-200)
    if (event.kind === 'status') {
      if (event.label === 'Starting') next.phase = 'starting'
      else if (event.label === 'Stopping') next.phase = 'stopping'
      else if (event.label === 'Interrupted') next.phase = 'interrupted'
      else if (next.phase === 'starting') next.phase = 'running'
    } else if (next.phase === 'starting') {
      next.phase = 'running'
    }
  } else if (event.kind === 'done') {
    next.phase = 'completed'
    next.error = null
  } else if (event.kind === 'error') {
    next.phase = 'failed'
    next.error = event.message
  }
  return next
}

export function chatUiReducer(state: ChatUiState, action: ChatUiAction): ChatUiState {
  switch (action.type) {
    case 'select':
      return { ...state, selectedSessionId: action.sessionId, notice: null }
    case 'new-chat':
      return { ...state, selectedSessionId: null, notice: null }
    case 'set-draft':
      return {
        ...state,
        drafts: { ...state.drafts, [action.key]: action.text.slice(0, MAX_SAVED_DRAFT_LENGTH) }
      }
    case 'set-mode':
      return { ...state, modes: { ...state.modes, [action.key]: action.mode } }
    case 'set-attachments':
      return { ...state, attachments: { ...state.attachments, [action.key]: action.attachments } }
    case 'promote-composition': {
      const mode = state.modes[action.fromKey] ?? 'analysis'
      return {
        ...state,
        selectedSessionId: action.sessionId,
        drafts: { ...state.drafts, [action.fromKey]: '', [action.sessionId]: '' },
        modes: { ...state.modes, [action.sessionId]: mode },
        attachments: {
          ...state.attachments,
          [action.fromKey]: [],
          [action.sessionId]: []
        },
        notice: null
      }
    }
    case 'remove-session': {
      const drafts = { ...state.drafts }
      const modes = { ...state.modes }
      const attachments = { ...state.attachments }
      delete drafts[action.sessionId]
      delete modes[action.sessionId]
      delete attachments[action.sessionId]
      return {
        ...state,
        selectedSessionId:
          state.selectedSessionId === action.sessionId ? null : state.selectedSessionId,
        drafts,
        modes,
        attachments
      }
    }
    case 'hydrate-runtime':
      if (
        state.runtime &&
        action.runtime &&
        state.runtime.generationId === action.runtime.generationId &&
        state.runtime.lastSequence > action.runtime.lastSequence
      ) {
        return state
      }
      return { ...state, runtime: action.runtime }
    case 'runtime-event':
      if (
        !state.runtime ||
        state.runtime.generationId !== action.envelope.generationId ||
        state.runtime.sessionId !== action.envelope.sessionId ||
        action.envelope.sequence <= state.runtime.lastSequence
      ) {
        return state
      }
      return { ...state, runtime: runtimeFromEnvelope(state.runtime, action.envelope) }
    case 'set-history-open':
      return { ...state, historyOpen: action.open }
    case 'set-work-log-open':
      return { ...state, workLogOpen: action.open }
    case 'set-notice':
      return { ...state, notice: action.notice }
  }
}
