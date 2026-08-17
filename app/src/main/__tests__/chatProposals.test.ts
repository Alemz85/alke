import { describe, expect, it } from 'vitest'
import {
  MAX_DETAIL_CHARS,
  buildProposalArgs,
  normalizeBlockDecision,
  trimOutput,
  validateBlockId,
  validateMessageIndex,
  validateProposalRequest,
  type ValidatedProposal
} from '../chatProposalPolicy'

const VALID_TEMPLATE_ID = '11111111-1111-1111-1111-111111111111'
const VALID_INJURY_ID = '22222222-2222-2222-2222-222222222222'
const NOT_A_UUID = 'not-a-uuid'

describe('validateProposalRequest — gym-template', () => {
  it('accepts a valid apply request with no baseTemplateId', () => {
    const result = validateProposalRequest({
      kind: 'gym-template',
      action: 'apply',
      document: { name: 'Push day' }
    })
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'gym-template',
        action: 'apply',
        documentJson: JSON.stringify({ name: 'Push day' })
      }
    })
  })

  it('rejects an apply request that carries a baseTemplateId', () => {
    const result = validateProposalRequest({
      kind: 'gym-template',
      action: 'apply',
      baseTemplateId: VALID_TEMPLATE_ID,
      document: {}
    })
    expect(result).toEqual({
      ok: false,
      error: 'baseTemplateId is only valid with action create-version'
    })
  })

  it('accepts create-version with a valid baseTemplateId', () => {
    const result = validateProposalRequest({
      kind: 'gym-template',
      action: 'create-version',
      baseTemplateId: VALID_TEMPLATE_ID,
      document: { name: 'Push day v2' }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        kind: 'gym-template',
        action: 'create-version',
        baseTemplateId: VALID_TEMPLATE_ID,
        documentJson: JSON.stringify({ name: 'Push day v2' })
      })
    }
  })

  it('rejects create-version with no baseTemplateId', () => {
    const result = validateProposalRequest({
      kind: 'gym-template',
      action: 'create-version',
      document: {}
    })
    expect(result).toEqual({
      ok: false,
      error: 'baseTemplateId must be a valid UUID for create-version'
    })
  })

  it('rejects create-version with a malformed baseTemplateId', () => {
    const result = validateProposalRequest({
      kind: 'gym-template',
      action: 'create-version',
      baseTemplateId: NOT_A_UUID,
      document: {}
    })
    expect(result).toEqual({
      ok: false,
      error: 'baseTemplateId must be a valid UUID for create-version'
    })
  })

  it('rejects an unknown action', () => {
    const result = validateProposalRequest({
      kind: 'gym-template',
      action: 'delete',
      document: {}
    })
    expect(result).toEqual({ ok: false, error: "action must be 'apply' or 'create-version'" })
  })
})

describe('validateProposalRequest — recovery-plan', () => {
  it('accepts a valid injuryId', () => {
    const result = validateProposalRequest({
      kind: 'recovery-plan',
      injuryId: VALID_INJURY_ID,
      document: { items: [] }
    })
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'recovery-plan',
        injuryId: VALID_INJURY_ID,
        documentJson: JSON.stringify({ items: [] })
      }
    })
  })

  it('rejects a missing injuryId', () => {
    const result = validateProposalRequest({ kind: 'recovery-plan', document: {} })
    expect(result).toEqual({ ok: false, error: 'injuryId must be a valid UUID' })
  })

  it('rejects a malformed injuryId', () => {
    const result = validateProposalRequest({
      kind: 'recovery-plan',
      injuryId: NOT_A_UUID,
      document: {}
    })
    expect(result).toEqual({ ok: false, error: 'injuryId must be a valid UUID' })
  })
})

describe('validateProposalRequest — shared guards', () => {
  it('rejects an unknown kind', () => {
    const result = validateProposalRequest({ kind: 'workout', document: {} })
    expect(result).toEqual({ ok: false, error: "kind must be 'gym-template' or 'recovery-plan'" })
  })

  it('rejects a non-object request', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(validateProposalRequest(bad)).toEqual({
        ok: false,
        error: 'request must be an object'
      })
    }
  })

  it('rejects a non-object document', () => {
    for (const bad of [null, 'x', 42, [], ['a']]) {
      const result = validateProposalRequest({
        kind: 'recovery-plan',
        injuryId: VALID_INJURY_ID,
        document: bad
      })
      expect(result).toEqual({ ok: false, error: 'document must be an object' })
    }
  })

  it('rejects a document over the 256 KB serialized cap', () => {
    const document = { blob: 'x'.repeat(256 * 1024) }
    const result = validateProposalRequest({
      kind: 'recovery-plan',
      injuryId: VALID_INJURY_ID,
      document
    })
    expect(result).toEqual({ ok: false, error: 'document exceeds the 256 KB size limit' })
  })

  it('accepts a document right at the cap boundary', () => {
    // {"blob":"..."} overhead is 9 chars; pad so the whole JSON lands exactly at the cap.
    const overhead = JSON.stringify({ blob: '' }).length
    const document = { blob: 'x'.repeat(256 * 1024 - overhead) }
    const result = validateProposalRequest({
      kind: 'recovery-plan',
      injuryId: VALID_INJURY_ID,
      document
    })
    expect(result.ok).toBe(true)
  })
})

describe('buildProposalArgs', () => {
  const tmpPath = '/tmp/alke-proposal-abc.json'

  it('builds gym.py template-apply args', () => {
    const value: ValidatedProposal = { kind: 'gym-template', action: 'apply', documentJson: '{}' }
    expect(buildProposalArgs(value, tmpPath)).toEqual([
      'gym.py',
      'template-apply',
      '--file',
      tmpPath
    ])
  })

  it('builds gym.py create-version args with the base template id positional', () => {
    const value: ValidatedProposal = {
      kind: 'gym-template',
      action: 'create-version',
      baseTemplateId: VALID_TEMPLATE_ID,
      documentJson: '{}'
    }
    expect(buildProposalArgs(value, tmpPath)).toEqual([
      'gym.py',
      'create-version',
      VALID_TEMPLATE_ID,
      '--file',
      tmpPath
    ])
  })

  it('builds injuries.py plan-apply args with the injury id positional', () => {
    const value: ValidatedProposal = {
      kind: 'recovery-plan',
      injuryId: VALID_INJURY_ID,
      documentJson: '{}'
    }
    expect(buildProposalArgs(value, tmpPath)).toEqual([
      'injuries.py',
      'plan-apply',
      VALID_INJURY_ID,
      '--file',
      tmpPath
    ])
  })
})

describe('trimOutput', () => {
  it('trims surrounding whitespace without truncating short text', () => {
    expect(trimOutput('  applied 3 template lines\n')).toBe('applied 3 template lines')
  })

  it('keeps the trailing ~2000 characters of longer output', () => {
    const body = 'a'.repeat(2100) + 'TAIL'
    const result = trimOutput(body)
    expect(result.length).toBe(2000)
    expect(result.endsWith('TAIL')).toBe(true)
  })
})

describe('validateMessageIndex', () => {
  it('accepts non-negative integers', () => {
    expect(validateMessageIndex(0)).toBe(0)
    expect(validateMessageIndex(5)).toBe(5)
  })

  it('rejects negatives, non-integers, and non-numbers', () => {
    for (const bad of [-1, 1.5, NaN, 'a', null, undefined, {}]) {
      expect(() => validateMessageIndex(bad)).toThrow(
        'messageIndex must be a non-negative integer'
      )
    }
  })
})

describe('validateBlockId', () => {
  it('accepts a non-empty string within the cap', () => {
    expect(validateBlockId('block-1')).toBe('block-1')
    expect(validateBlockId('x'.repeat(200))).toBe('x'.repeat(200))
  })

  it('rejects empty strings, oversize strings, and non-strings', () => {
    for (const bad of ['', 'x'.repeat(201), 42, null, undefined]) {
      expect(() => validateBlockId(bad)).toThrow(
        'blockId must be a non-empty string of at most 200 characters'
      )
    }
  })
})

describe('normalizeBlockDecision', () => {
  const at = '2026-08-17T12:00:00.000Z'

  it('accepts each valid status and stamps the server-provided time', () => {
    for (const status of ['applied', 'discarded', 'failed'] as const) {
      expect(normalizeBlockDecision({ status }, at)).toEqual({ status, at })
    }
  })

  it('ignores a client-provided at and overwrites it with the server time', () => {
    expect(normalizeBlockDecision({ status: 'applied', at: '1999-01-01T00:00:00.000Z' }, at)).toEqual(
      { status: 'applied', at }
    )
  })

  it('truncates an oversize detail instead of rejecting it', () => {
    const detail = 'x'.repeat(MAX_DETAIL_CHARS + 500)
    const result = normalizeBlockDecision({ status: 'failed', detail }, at)
    expect(result.detail).toHaveLength(MAX_DETAIL_CHARS)
    expect(result.detail).toBe(detail.slice(0, MAX_DETAIL_CHARS))
  })

  it('omits detail when absent', () => {
    expect(normalizeBlockDecision({ status: 'discarded' }, at)).toEqual({
      status: 'discarded',
      at
    })
  })

  it('rejects an unknown status', () => {
    expect(() => normalizeBlockDecision({ status: 'pending' }, at)).toThrow(
      "decision.status must be 'applied', 'discarded', or 'failed'"
    )
  })

  it('rejects a non-string detail and a non-object decision', () => {
    expect(() => normalizeBlockDecision({ status: 'applied', detail: 42 }, at)).toThrow(
      'decision.detail must be a string'
    )
    expect(() => normalizeBlockDecision(null, at)).toThrow('decision must be an object')
    expect(() => normalizeBlockDecision('applied', at)).toThrow('decision must be an object')
  })
})
