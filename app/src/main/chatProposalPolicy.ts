// Pure validation/args-building logic for chat proposal blocks (electron-free,
// mirrors chatPolicy.ts's split so this half is directly unit-testable). The
// chatctx python scripts (gym.py / injuries.py) are the actual validation
// authority for a proposal's document contents — everything here only
// establishes that the IPC request is well-formed enough to spawn them safely:
// a known kind/action, a UUID where one is required, and a document that is a
// plain object under the size cap. The document's business-rule validity is
// entirely the python scripts' job.
import type { ChatBlockDecision } from '@shared/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_DOCUMENT_BYTES = 256 * 1024
export const MAX_OUTPUT_CHARS = 2000
export const MAX_BLOCK_ID_CHARS = 200
export const MAX_DETAIL_CHARS = 4000

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

interface ValidatedGymTemplateApply {
  kind: 'gym-template'
  action: 'apply'
  documentJson: string
}

interface ValidatedGymTemplateCreateVersion {
  kind: 'gym-template'
  action: 'create-version'
  baseTemplateId: string
  documentJson: string
}

interface ValidatedRecoveryPlan {
  kind: 'recovery-plan'
  injuryId: string
  documentJson: string
}

export type ValidatedProposal =
  | ValidatedGymTemplateApply
  | ValidatedGymTemplateCreateVersion
  | ValidatedRecoveryPlan

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function validateDocument(document: unknown): ValidationResult<string> {
  if (!isPlainObject(document)) return { ok: false, error: 'document must be an object' }
  let json: string
  try {
    json = JSON.stringify(document)
  } catch (error) {
    return {
      ok: false,
      error: `document is not serializable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: 'document exceeds the 256 KB size limit' }
  }
  return { ok: true, value: json }
}

/**
 * Validates an untrusted `ChatProposalRequest` from the renderer. Every branch
 * returns rather than throws — the IPC handler surfaces `{ ok: false, error }`
 * to the renderer instead of a rejected promise, matching ChatProposalResult.
 */
export function validateProposalRequest(request: unknown): ValidationResult<ValidatedProposal> {
  if (!isPlainObject(request)) return { ok: false, error: 'request must be an object' }

  const kind = request.kind
  if (kind !== 'gym-template' && kind !== 'recovery-plan') {
    return { ok: false, error: "kind must be 'gym-template' or 'recovery-plan'" }
  }

  const documentCheck = validateDocument(request.document)
  if (!documentCheck.ok) return documentCheck

  if (kind === 'gym-template') {
    const action = request.action
    if (action !== 'apply' && action !== 'create-version') {
      return { ok: false, error: "action must be 'apply' or 'create-version'" }
    }

    if (action === 'create-version') {
      if (!isUuid(request.baseTemplateId)) {
        return { ok: false, error: 'baseTemplateId must be a valid UUID for create-version' }
      }
      return {
        ok: true,
        value: {
          kind,
          action,
          baseTemplateId: request.baseTemplateId,
          documentJson: documentCheck.value
        }
      }
    }

    if (request.baseTemplateId !== undefined) {
      return { ok: false, error: 'baseTemplateId is only valid with action create-version' }
    }
    return { ok: true, value: { kind, action, documentJson: documentCheck.value } }
  }

  if (!isUuid(request.injuryId)) {
    return { ok: false, error: 'injuryId must be a valid UUID' }
  }
  return { ok: true, value: { kind, injuryId: request.injuryId, documentJson: documentCheck.value } }
}

/** Builds the `python3 <script> ...` argv (script name included) for execFile. */
export function buildProposalArgs(value: ValidatedProposal, tmpPath: string): string[] {
  if (value.kind === 'gym-template') {
    return value.action === 'create-version'
      ? ['gym.py', 'create-version', value.baseTemplateId, '--file', tmpPath]
      : ['gym.py', 'template-apply', '--file', tmpPath]
  }
  return ['injuries.py', 'plan-apply', value.injuryId, '--file', tmpPath]
}

/** Trims to the trailing ~2000 chars after trimming surrounding whitespace — the
 *  failure signal from these scripts (a raised SystemExit message, a traceback)
 *  is almost always at the tail. */
export function trimOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(-max) : trimmed
}

export function validateMessageIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('messageIndex must be a non-negative integer')
  }
  return value
}

export function validateBlockId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BLOCK_ID_CHARS) {
    throw new Error(`blockId must be a non-empty string of at most ${MAX_BLOCK_ID_CHARS} characters`)
  }
  return value
}

const BLOCK_DECISION_STATUSES = new Set(['applied', 'discarded', 'failed'])

/**
 * Validates a renderer-supplied decision and stamps `at` server-side — any
 * client-provided `at` is ignored outright, never merely overwritten-if-present.
 */
export function normalizeBlockDecision(value: unknown, at: string): ChatBlockDecision {
  if (!isPlainObject(value)) throw new Error('decision must be an object')

  const status = value.status
  if (typeof status !== 'string' || !BLOCK_DECISION_STATUSES.has(status)) {
    throw new Error("decision.status must be 'applied', 'discarded', or 'failed'")
  }

  const rawDetail = value.detail
  if (rawDetail !== undefined && typeof rawDetail !== 'string') {
    throw new Error('decision.detail must be a string')
  }

  const decision: ChatBlockDecision = { status: status as ChatBlockDecision['status'], at }
  if (typeof rawDetail === 'string') decision.detail = rawDetail.slice(0, MAX_DETAIL_CHARS)
  return decision
}
