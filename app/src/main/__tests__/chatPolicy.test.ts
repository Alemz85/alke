import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_STREAM_STDIO,
  CHAT_ALLOWED_TOOLS,
  buildGoalClaudeArgs,
  buildStreamingClaudeArgs,
  closeChildStdin
} from '../chatPolicy'

const EXPECTED_HEALTH_HELPERS = [
  'Bash(python3 db.py:*)',
  'Bash(python db.py:*)',
  'Bash(python3 injuries.py:*)',
  'Bash(python3 goals.py:*)',
  'Bash(python3 agent_log.py:*)',
  'Bash(python3 gym.py:*)',
  'Bash(node recovery_plan_contract.mjs:*)',
  'Bash(node workout_template_contract.mjs:*)'
]

const chatSource = readFileSync(resolve(import.meta.dirname, '../chat.ts'), 'utf8')
const builderConfig = readFileSync(
  resolve(import.meta.dirname, '../../../electron-builder.yml'),
  'utf8'
)

describe('Claude headless policy', () => {
  it('exports exactly the narrow health-helper allowlist', () => {
    expect(CHAT_ALLOWED_TOOLS).toEqual(EXPECTED_HEALTH_HELPERS)
    expect(CHAT_ALLOWED_TOOLS).toHaveLength(8)
    expect(CHAT_ALLOWED_TOOLS).not.toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']))
  })

  it('builds exact streaming arguments without a resume id', () => {
    expect(buildStreamingClaudeArgs('hello')).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      ...EXPECTED_HEALTH_HELPERS
    ])
  })

  it('puts an optional resume id before the permission tail', () => {
    expect(buildStreamingClaudeArgs('continue', 'session-123')).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--resume',
      'session-123',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      ...EXPECTED_HEALTH_HELPERS
    ])
  })

  it('builds exact goal arguments from the same permission policy', () => {
    expect(buildGoalClaudeArgs('build it')).toEqual([
      '-p',
      'build it',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      ...EXPECTED_HEALTH_HELPERS
    ])
  })

  it('never grants broad tools or bypasses permissions', () => {
    const args = [buildStreamingClaudeArgs('stream'), buildGoalClaudeArgs('goal')]

    for (const invocation of args) {
      const allowlistStart = invocation.indexOf('--allowedTools') + 1
      expect(invocation.slice(allowlistStart)).toEqual(EXPECTED_HEALTH_HELPERS)
      expect(invocation).not.toContain('--dangerously-skip-permissions')
      expect(invocation).not.toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']))
    }
  })

  it('uses ignored stdin and piped output for streaming', () => {
    expect(CLAUDE_STREAM_STDIO).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('closes an available child stdin and tolerates an absent one', () => {
    const end = vi.fn()
    const childWithStdin = { stdin: { end } } as unknown as Parameters<typeof closeChildStdin>[0]
    const childWithoutStdin = { stdin: null } as Parameters<typeof closeChildStdin>[0]

    closeChildStdin(childWithStdin)

    expect(end).toHaveBeenCalledOnce()
    expect(() => closeChildStdin(childWithoutStdin)).not.toThrow()
  })
})

describe('Claude policy integration', () => {
  it('wires the streaming builder and stdio tuple into the chat spawn', () => {
    expect(chatSource).toContain("from './chatPolicy'")
    expect(chatSource).toContain(
      'buildStreamingClaudeArgs(prompt, session.claude_session_id ?? undefined)'
    )
    expect(chatSource).toMatch(
      /spawn\('claude', args, \{[\s\S]*?stdio: CLAUDE_STREAM_STDIO[\s\S]*?\}\)/
    )
  })

  it('wires the goal builder and immediately closes the exec child stdin', () => {
    expect(chatSource).toMatch(
      /const child = execFile\([\s\S]*?buildGoalClaudeArgs\(prompt\)[\s\S]*?\)\n\s*closeChildStdin\(child\)/
    )
  })

  it('packages only the Claude health skills while preserving the Alke config', () => {
    expect(builderConfig).toContain('productName: Alke')
    expect(builderConfig).toContain('icon: build/icon.icns')
    expect(builderConfig).toMatch(
      /- from: \.\.\/chatctx\/\.claude\/skills\s+to: chatctx\/\.claude\/skills/
    )
    expect(builderConfig).not.toMatch(/from: \.\.\/chatctx\/\.claude\s*$/m)
    expect(builderConfig).not.toMatch(/to: chatctx\/\.claude\s*$/m)
  })
})
