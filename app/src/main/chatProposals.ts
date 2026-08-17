// Confirm action for chat proposal blocks ("apply this template" / "apply this
// recovery plan" cards rendered from ```alke:template / ```alke:recovery-plan
// fences). Applies through the SAME chatctx write scripts the chat agent uses
// (gym.py, injuries.py) — those scripts are the validation authority and abort
// without writes on a bad document, so this module's own validation only needs
// to guard the process-spawn boundary (well-formed request, single-flight,
// temp-file lifecycle), not the document's business rules.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { IPC_CHANNELS, type ChatProposalResult } from '@shared/types'
import {
  buildProposalArgs,
  normalizeBlockDecision,
  trimOutput,
  validateBlockId,
  validateMessageIndex,
  validateProposalRequest
} from './chatProposalPolicy'
import * as db from './db'

// Same resolution as chat.ts's CHATCTX_DIR — kept as an independent constant
// (rather than imported) since chat.ts does not export it.
const CHATCTX_DIR = app.isPackaged
  ? join(process.resourcesPath, 'chatctx')
  : join(__dirname, '../../../chatctx')

const APPLY_TIMEOUT_MS = 120_000
const APPLY_MAX_BUFFER = 10 * 1024 * 1024

// Serialized main-side: a second Confirm click while one apply is running is
// rejected rather than queued — the renderer's Confirm button should already
// be disabled mid-apply, this is the untrusted-IPC backstop.
let applyInFlight = false

function runPython(args: string[]): Promise<ChatProposalResult> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      args,
      { cwd: CHATCTX_DIR, env: process.env, timeout: APPLY_TIMEOUT_MS, maxBuffer: APPLY_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, output: trimOutput(stdout) })
          return
        }
        const message =
          trimOutput(stderr) ||
          trimOutput(stdout) ||
          (error instanceof Error ? error.message : String(error))
        resolve({ ok: false, error: message || 'proposal apply failed' })
      }
    )
  })
}

async function applyProposal(request: unknown): Promise<ChatProposalResult> {
  const validated = validateProposalRequest(request)
  if (!validated.ok) return { ok: false, error: validated.error }

  if (applyInFlight) {
    return { ok: false, error: 'another proposal apply is already running' }
  }
  applyInFlight = true

  const tmpPath = join(app.getPath('temp'), `alke-proposal-${randomUUID()}.json`)
  try {
    await writeFile(tmpPath, validated.value.documentJson, { encoding: 'utf8', mode: 0o600 })
    return await runPython(buildProposalArgs(validated.value, tmpPath))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    applyInFlight = false
    await unlink(tmpPath).catch(() => {})
  }
}

ipcMain.handle(IPC_CHANNELS.chatApplyProposal, (_event, request: unknown) =>
  applyProposal(request)
)

ipcMain.handle(
  IPC_CHANNELS.chatSetBlockDecision,
  async (
    _event,
    sessionId: string,
    messageIndexInput: unknown,
    blockIdInput: unknown,
    decisionInput: unknown
  ) => {
    const messageIndex = validateMessageIndex(messageIndexInput)
    const blockId = validateBlockId(blockIdInput)
    const decision = normalizeBlockDecision(decisionInput, new Date().toISOString())

    const session = await db.getChatSession(sessionId)
    if (!session) throw new Error('chat session not found')

    const messages = session.messages ?? []
    if (messageIndex >= messages.length) throw new Error('messageIndex is out of bounds')
    const target = messages[messageIndex]
    if (target.role !== 'assistant') {
      throw new Error('messageIndex must reference an assistant message')
    }

    const updatedMessages = messages.map((message, index) =>
      index === messageIndex
        ? { ...message, blockDecisions: { ...(message.blockDecisions ?? {}), [blockId]: decision } }
        : message
    )
    await db.updateChatSession(sessionId, { messages: updatedMessages })
  }
)
