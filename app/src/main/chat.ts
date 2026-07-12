// Claude Code CLI integration (SPEC §7). Each user message spawns
// `claude -p <msg> --output-format stream-json` in /chatctx (resuming the
// CLI session when one exists); parsed events stream to the renderer over
// IPC. The CLI runs ONLY on user message send — never scheduled.
import { execFile, spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS, type ChatStatus, type ChatStreamEvent } from '@shared/types'
import * as db from './db'

// Packaged apps can't reach the source tree relative to __dirname (which
// resolves inside app.asar); ship chatctx as an extraResource instead (see
// electron-builder.yml) and read it from resourcesPath when packaged.
// Ensure no claude CLI child outlives the app.
app.on('before-quit', () => {
  for (const [, entry] of activeChildren) entry.child.kill('SIGTERM')
})

const CHATCTX_DIR = app.isPackaged
  ? join(process.resourcesPath, 'chatctx')
  : join(__dirname, '../../../chatctx')

// Chat sessions are routed to a role via chatctx's `health` skill: the first
// message of a fresh CLI session opens with `/health <mode>`, which makes the
// agent read that mode's instruction files (chatctx/modes/). Resumed CLI
// sessions already carry the mode files in context, so no prefix is re-sent.
export type ChatMode = 'analysis' | 'injuries' | 'goals'
const DEFAULT_MODE: ChatMode = 'analysis'

// Standard closing sentence for every headless (non-interactive) spawn, so
// the contract is one shared constant instead of ad-hoc phrasing per caller.
const NONINTERACTIVE_SUFFIX =
  'Run end-to-end without asking for confirmations; make reasonable assumptions and state them.'

// Tracks the in-flight CLI child process per DB session id, so a stop
// request can locate and signal the right one. `markStopped` flips the
// closure-local `stopped` flag in the matching sendMessage() call, so its
// `close` handler emits `done` instead of `error` for a deliberate stop.
const activeChildren = new Map<string, { child: ChildProcess; markStopped: () => void }>()

export function checkClaude(): Promise<ChatStatus> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 10_000 }, (error, stdout) => {
      if (error) resolve({ available: false, error: error.message })
      else resolve({ available: true, version: stdout.trim() })
    })
  })
}

export async function sendMessage(
  window: BrowserWindow,
  sessionId: string | null,
  message: string,
  mode: ChatMode = DEFAULT_MODE
): Promise<{ sessionId: string }> {
  let session = sessionId ? await db.getChatSession(sessionId) : null
  if (!session) {
    session = await db.createChatSession(message.slice(0, 80))
  }
  const messages = [...(session.messages ?? [])]
  messages.push({ role: 'user', content: message, ts: new Date().toISOString() })
  await db.updateChatSession(session.id, { messages })

  const emit = (event: ChatStreamEvent): void => {
    if (!window.isDestroyed()) window.webContents.send('chat:stream', { sessionId: session!.id, event })
  }

  // Fresh CLI session → open with the mode route; the stored/displayed
  // message stays the raw user text, only the spawned prompt is prefixed.
  const prompt = session.claude_session_id ? message : `/health ${mode}\n\n${message}`
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages'
  ]
  if (session.claude_session_id) args.push('--resume', session.claude_session_id)

  const child = spawn('claude', args, { cwd: CHATCTX_DIR, env: process.env })
  let assistantText = ''
  let stderr = ''
  let buffer = ''
  let stopped = false
  activeChildren.set(session.id, {
    child,
    markStopped: () => {
      stopped = true
    }
  })

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      handleCliEvent(event)
    }
  })

  function handleCliEvent(event: Record<string, unknown>): void {
    const type = event.type
    if (type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
      void db.updateChatSession(session!.id, { claude_session_id: event.session_id })
      session!.claude_session_id = event.session_id
      return
    }
    if (type === 'stream_event') {
      const inner = event.event as Record<string, unknown> | undefined
      if (!inner) return
      const innerType = inner.type
      if (innerType === 'content_block_start') {
        const block = inner.content_block as Record<string, unknown> | undefined
        if (block?.type === 'text' && assistantText && !assistantText.endsWith('\n')) {
          assistantText += '\n\n'
          emit({ kind: 'text', text: '\n\n' })
        }
        return
      }
      if (innerType === 'content_block_delta') {
        const delta = inner.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          assistantText += delta.text
          emit({ kind: 'text', text: delta.text })
        }
        return
      }
      // Unknown stream_event types (message_start, content_block_stop,
      // message_delta, message_stop, etc.) are ignored.
      return
    }
    if (type === 'assistant') {
      // With --include-partial-messages, text is already emitted/accumulated
      // via stream_event text deltas above. Only extract tool_use blocks here
      // to avoid double-counting/duplicating text.
      const content = (event.message as { content?: unknown[] } | undefined)?.content ?? []
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'tool_use') {
          if (assistantText && !assistantText.endsWith('\n')) assistantText += '\n\n'
          emit({ kind: 'text', text: '\n\n' })
          const input = JSON.stringify(block.input ?? {})
          emit({
            kind: 'tool',
            name: String(block.name ?? 'tool'),
            detail: input.length > 400 ? `${input.slice(0, 400)}…` : input
          })
        }
      }
    }
  }

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  child.on('close', (code) => {
    void (async () => {
      activeChildren.delete(session!.id)
      if (assistantText.trim().length > 0) {
        messages.push({ role: 'assistant', content: assistantText, ts: new Date().toISOString() })
        await db.updateChatSession(session!.id, { messages })
      }
      if (code === 0 || stopped) emit({ kind: 'done' })
      else emit({ kind: 'error', message: stderr.trim() || `claude exited with code ${code}` })
    })()
  })

  child.on('error', (error) => {
    activeChildren.delete(session!.id)
    emit({ kind: 'error', message: `failed to start claude CLI: ${error.message}` })
  })

  return { sessionId: session.id }
}

// One headless CLI run per goal: the chat agent (with its chatctx/CLAUDE.md
// Goals instructions) designs the goal's progress metric and writes it via
// goals.py. Plain -p output — nothing streams to the renderer; the caller
// refetches goals when the promise resolves. Runs ONLY on explicit request
// from the Profile tab — never scheduled.
const METRIC_BUILD_TIMEOUT_MS = 5 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const metricBuildsInFlight = new Set<string>()

export function buildGoalMetric(goalId: string): Promise<{ ok: boolean; error?: string }> {
  if (!UUID_RE.test(goalId)) {
    return Promise.resolve({ ok: false, error: 'invalid goal id' })
  }
  if (metricBuildsInFlight.has(goalId)) {
    return Promise.resolve({ ok: false, error: 'metric build already running for this goal' })
  }
  metricBuildsInFlight.add(goalId)

  const prompt =
    `/health goals\n\n` +
    `A goal card with id ${goalId} was just created in the app and has no progress metric yet. ` +
    `Follow your goals-mode instructions: read the goal (python3 goals.py list, ` +
    `plus db.py for the data), design its progress metric, save it with goals.py set-metric, ` +
    `materialize the series with goals.py recompute, and if the goal's description is empty ` +
    `write a short factual one via goals.py update. ${NONINTERACTIVE_SUFFIX}`

  return new Promise((resolve) => {
    execFile(
      'claude',
      ['-p', prompt],
      { cwd: CHATCTX_DIR, env: process.env, timeout: METRIC_BUILD_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        metricBuildsInFlight.delete(goalId)
        if (error) {
          resolve({ ok: false, error: String(stderr).trim() || error.message })
        } else {
          resolve({ ok: true })
        }
      }
    )
  })
}

// Kills the in-flight CLI process for a session, if any. The `close`
// handler in sendMessage() still runs afterward — it persists whatever
// partial text was accumulated and, because markStopped() flips `stopped`
// first, emits `done` rather than `error` for this deliberate stop.
export function stopMessage(sessionId: string): boolean {
  const entry = activeChildren.get(sessionId)
  if (!entry) return false
  entry.markStopped()
  return entry.child.kill('SIGTERM')
}

// Registered here (not main/index.ts, which is owned by another surface)
// so the stop button has an IPC channel to call.
ipcMain.handle(IPC_CHANNELS.chatStop, (_event, sessionId: string) => stopMessage(sessionId))

// Registered here (not main/index.ts, which is owned by another surface)
// so session rename/delete have IPC channels to call.
ipcMain.handle(IPC_CHANNELS.chatRename, (_event, id: string, title: string) =>
  db.renameChatSession(id, title)
)
ipcMain.handle(IPC_CHANNELS.chatDelete, (_event, id: string) => db.deleteChatSession(id))
