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
const EXPECTED_BUILTIN_TOOLS = 'Read,Glob,Grep,Bash,Skill'
const EXPECTED_INLINE_SETTINGS = {
  permissions: { allow: EXPECTED_HEALTH_HELPERS },
  disableAllHooks: true,
  autoMemoryEnabled: false
}
const EXPECTED_PERMISSION_ARGS = [
  '--permission-mode',
  'dontAsk',
  '--setting-sources',
  'project',
  '--settings',
  JSON.stringify(EXPECTED_INLINE_SETTINGS),
  '--tools',
  EXPECTED_BUILTIN_TOOLS,
  '--strict-mcp-config',
  '--disallowedTools',
  'mcp__*',
  '--allowedTools',
  ...EXPECTED_HEALTH_HELPERS
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
      ...EXPECTED_PERMISSION_ARGS
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
      ...EXPECTED_PERMISSION_ARGS
    ])
  })

  it('builds exact goal arguments from the same permission policy', () => {
    expect(buildGoalClaudeArgs('build it')).toEqual(['-p', 'build it', ...EXPECTED_PERMISSION_ARGS])
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

  it('loads only project settings so the health skill remains without user or local policy', () => {
    for (const invocation of [buildStreamingClaudeArgs('stream'), buildGoalClaudeArgs('goal')]) {
      const settingSourcesIndex = invocation.indexOf('--setting-sources')
      expect(settingSourcesIndex).toBeGreaterThan(-1)
      expect(invocation[settingSourcesIndex + 1]).toBe('project')
      expect(invocation).not.toContain('user')
      expect(invocation).not.toContain('local')
    }
  })

  it('supplies exact inline permissions while disabling hooks and memory', () => {
    for (const invocation of [buildStreamingClaudeArgs('stream'), buildGoalClaudeArgs('goal')]) {
      const settingsIndex = invocation.indexOf('--settings')
      expect(settingsIndex).toBeGreaterThan(-1)
      expect(JSON.parse(invocation[settingsIndex + 1] ?? '{}')).toEqual(EXPECTED_INLINE_SETTINGS)
    }
  })

  it('restricts built-ins to read-only discovery plus the narrow Bash helpers and Skill router', () => {
    for (const invocation of [buildStreamingClaudeArgs('stream'), buildGoalClaudeArgs('goal')]) {
      const toolsIndex = invocation.indexOf('--tools')
      expect(toolsIndex).toBeGreaterThan(-1)
      const tools = (invocation[toolsIndex + 1] ?? '').split(',').filter(Boolean)
      expect(tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Skill'])
      expect(tools).not.toEqual(
        expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'])
      )
    }
  })

  it('blocks every MCP tool and keeps variadic allowedTools as the final argument tail', () => {
    for (const invocation of [buildStreamingClaudeArgs('stream'), buildGoalClaudeArgs('goal')]) {
      const allowedToolsIndex = invocation.indexOf('--allowedTools')
      expect(invocation).toContain('--strict-mcp-config')
      expect(
        invocation.slice(invocation.indexOf('--disallowedTools') + 1, allowedToolsIndex)
      ).toEqual(['mcp__*'])
      expect(invocation.slice(allowedToolsIndex + 1)).toEqual(EXPECTED_HEALTH_HELPERS)
    }
  })

  it('does not derive pure builder output from simulated broad user settings', () => {
    const broadUserSettingsFixture = JSON.stringify({
      permissions: { allow: ['Bash', 'Edit', 'Write', 'mcp__*'] },
      disableAllHooks: false,
      autoMemoryEnabled: true
    })
    const baseline = buildGoalClaudeArgs('goal')

    vi.stubEnv('CLAUDE_USER_SETTINGS_FIXTURE', broadUserSettingsFixture)
    try {
      const isolatedInvocation = buildGoalClaudeArgs('goal')
      expect(isolatedInvocation).toEqual(baseline)
      expect(isolatedInvocation[isolatedInvocation.indexOf('--setting-sources') + 1]).toBe(
        'project'
      )
      const inlineSettingsIndex = isolatedInvocation.indexOf('--settings')
      expect(JSON.parse(isolatedInvocation[inlineSettingsIndex + 1] ?? '{}')).toEqual(
        EXPECTED_INLINE_SETTINGS
      )
    } finally {
      vi.unstubAllEnvs()
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
