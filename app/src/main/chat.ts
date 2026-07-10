// Claude Code CLI integration (SPEC §7). Each user message spawns
// `claude -p <msg> --output-format stream-json` in /chatctx (resuming the
// CLI session when one exists); parsed events stream to the renderer over
// IPC. The CLI runs ONLY on user message send — never scheduled.
import { execFile, spawn } from 'child_process'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import type { ChatStatus, ChatStreamEvent } from '@shared/types'
import * as db from './db'

const CHATCTX_DIR = join(__dirname, '../../../chatctx')

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

  const args = ['-p', message, '--output-format', 'stream-json', '--verbose']
  if (session.claude_session_id) args.push('--resume', session.claude_session_id)

  const child = spawn('claude', args, { cwd: CHATCTX_DIR, env: process.env })
  let assistantText = ''
  let stderr = ''
  let buffer = ''

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
    if (type === 'assistant') {
      const content = (event.message as { content?: unknown[] } | undefined)?.content ?? []
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (assistantText && !assistantText.endsWith('\n')) assistantText += '\n\n'
          assistantText += block.text
          emit({ kind: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
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
      if (assistantText.trim().length > 0) {
        messages.push({ role: 'assistant', content: assistantText, ts: new Date().toISOString() })
        await db.updateChatSession(session!.id, { messages })
      }
      if (code === 0) emit({ kind: 'done' })
      else emit({ kind: 'error', message: stderr.trim() || `claude exited with code ${code}` })
    })()
  })

  child.on('error', (error) => {
    emit({ kind: 'error', message: `failed to start claude CLI: ${error.message}` })
  })

  return { sessionId: session.id }
}
