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
  message: string
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

  const args = [
    '-p',
    message,
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
