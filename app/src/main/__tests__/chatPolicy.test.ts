import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_STREAM_STDIO,
  CHAT_ALLOWED_TOOLS,
  buildGoalClaudeArgs,
  buildInteractiveSettings,
  buildStreamingClaudeArgs,
  closeChildStdin,
  extractClaudeCliFailure,
  supabaseHostFrom,
  type ChatPolicyPaths
} from '../chatPolicy'

const EXPECTED_HEALTH_HELPERS = [
  'Bash(python3 db.py:*)',
  'Bash(python db.py:*)',
  'Bash(python3 injuries.py:*)',
  'Bash(python3 goals.py:*)',
  'Bash(python3 agent_log.py:*)',
  'Bash(python3 session.py:*)',
  'Bash(python3 gym.py:*)',
  'Bash(python3 ctx.py:*)',
  'Bash(node recovery_plan_contract.mjs:*)',
  'Bash(node workout_template_contract.mjs:*)'
]

const PACKAGED_PATHS: ChatPolicyPaths = {
  repoRoot: '/Users/owner/Projects/Github/Alke',
  appRoot: '/Users/owner/Projects/Github/Alke/app',
  gitRoot: '/Users/owner/Projects/Github/Alke/.git',
  runtimeRoot: '/Applications/Alke.app/Contents/Resources/chatctx',
  homeRoot: '/Users/owner',
  attachmentPaths: ['/Users/owner/Desktop/plan.pdf'],
  supabaseHost: 'your-project-ref.supabase.co'
}

function settingsFrom(args: string[]): Record<string, any> {
  const index = args.indexOf('--settings')
  if (index < 0) throw new Error('settings argument not found')
  return JSON.parse(args[index + 1] ?? '{}') as Record<string, any>
}

describe('interactive Claude policy', () => {
  it('grants repo tools through acceptEdits without bypass mode', () => {
    const args = buildStreamingClaudeArgs('hello', undefined, PACKAGED_PATHS)

    expect(args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'acceptEdits',
        '--tools',
        'Read,Glob,Grep,Edit,Write,Bash,Skill,WebSearch,WebFetch',
        '--add-dir',
        PACKAGED_PATHS.repoRoot
      ])
    )
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--allow-dangerously-skip-permissions')
  })

  it('keeps resume before the permission tail', () => {
    const args = buildStreamingClaudeArgs('continue', 'session-123', PACKAGED_PATHS)
    expect(args.slice(0, 13)).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-opus-5',
      '--effort',
      'high',
      '--resume',
      'session-123',
      '--permission-mode'
    ])
  })

  it('pins the model and effort level regardless of the CLI default', () => {
    const streaming = buildStreamingClaudeArgs('hello', undefined, PACKAGED_PATHS)
    const goal = buildGoalClaudeArgs('build it')

    expect(streaming).toEqual(
      expect.arrayContaining(['--model', 'claude-opus-5', '--effort', 'high'])
    )
    expect(goal).toEqual(
      expect.arrayContaining(['--model', 'claude-opus-5', '--effort', 'high'])
    )
  })

  it('duplicates app, git, env, and packaged-runtime denies across tool and OS layers', () => {
    const settings = buildInteractiveSettings(PACKAGED_PATHS) as Record<string, any>
    const deny = settings.permissions.deny as string[]
    const filesystem = settings.sandbox.filesystem as Record<string, string[]>

    expect(deny).toEqual(
      expect.arrayContaining([
        'Edit(//Users/owner/Projects/Github/Alke/app/**)',
        'Write(//Users/owner/Projects/Github/Alke/app/**)',
        'Edit(//Users/owner/Projects/Github/Alke/.git/**)',
        'Write(//Users/owner/Projects/Github/Alke/.git/**)',
        'Read(//Users/owner/Projects/Github/Alke/**/.env*)',
        'Edit(//Users/owner/Projects/Github/Alke/**/.env*)',
        'Write(//Users/owner/Projects/Github/Alke/**/.env*)'
      ])
    )
    expect(filesystem.allowWrite).toEqual([PACKAGED_PATHS.repoRoot])
    expect(filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        PACKAGED_PATHS.appRoot,
        PACKAGED_PATHS.gitRoot,
        `${PACKAGED_PATHS.repoRoot}/**/.env*`,
        PACKAGED_PATHS.runtimeRoot
      ])
    )
    expect(filesystem.denyRead).toEqual(
      expect.arrayContaining([PACKAGED_PATHS.homeRoot, `${PACKAGED_PATHS.repoRoot}/**/.env*`])
    )
    expect(filesystem.allowRead).toEqual(
      expect.arrayContaining([PACKAGED_PATHS.repoRoot, ...PACKAGED_PATHS.attachmentPaths])
    )
  })

  it('does not deny the writable source chatctx when it is inside the repo', () => {
    const devPaths: ChatPolicyPaths = {
      ...PACKAGED_PATHS,
      runtimeRoot: `${PACKAGED_PATHS.repoRoot}/chatctx`,
      attachmentPaths: []
    }
    const settings = buildInteractiveSettings(devPaths) as Record<string, any>

    expect(settings.sandbox.filesystem.denyWrite).not.toContain(devPaths.runtimeRoot)
  })

  it('fails closed, auto-allows only sandboxed Bash, and limits Bash network access', () => {
    const settings = settingsFrom(
      buildStreamingClaudeArgs('hello', undefined, PACKAGED_PATHS)
    )

    expect(settings.sandbox).toMatchObject({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      network: { allowedDomains: ['your-project-ref.supabase.co'] }
    })
  })

  it('takes the sandbox network host from SUPABASE_URL and allows nothing without it', () => {
    expect(supabaseHostFrom('https://your-project-ref.supabase.co')).toBe(
      'your-project-ref.supabase.co'
    )
    expect(supabaseHostFrom(undefined)).toBeNull()
    expect(supabaseHostFrom('not a url')).toBeNull()
    const settings = buildInteractiveSettings({ ...PACKAGED_PATHS, supabaseHost: null }) as Record<
      string,
      any
    >
    expect(settings.sandbox.network.allowedDomains).toEqual([])
  })

  it('lets the agent read the private root but never write it, and loads its private skills', () => {
    const paths: ChatPolicyPaths = {
      ...PACKAGED_PATHS,
      privateRoot: `${PACKAGED_PATHS.repoRoot}/private`,
      privateChatctxDir: `${PACKAGED_PATHS.repoRoot}/private/chatctx`
    }
    const settings = buildInteractiveSettings(paths) as Record<string, any>
    expect(settings.sandbox.filesystem.denyWrite).toContain(paths.privateRoot)
    expect(settings.sandbox.filesystem.allowRead).toContain(PACKAGED_PATHS.repoRoot)

    const args = buildStreamingClaudeArgs('hello', undefined, paths)
    const addDirs = args.flatMap((arg, i) => (arg === '--add-dir' ? [args[i + 1]] : []))
    expect(addDirs).toEqual([PACKAGED_PATHS.repoRoot, paths.privateChatctxDir])
  })

  it('adds no private --add-dir when there is no private root', () => {
    const args = buildStreamingClaudeArgs('hello', undefined, PACKAGED_PATHS)
    expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(1)
  })

  it('blocks MCP and notebook escape surfaces, but allows WebSearch/WebFetch', () => {
    const args = buildStreamingClaudeArgs('hello', undefined, PACKAGED_PATHS)
    const denied = args[args.indexOf('--disallowedTools') + 1]
    const tools = args[args.indexOf('--tools') + 1]

    expect(args).toContain('--strict-mcp-config')
    // WebSearch/WebFetch run server-side over the Anthropic API connection, so they
    // work even though the sandbox network allowlist below only permits Supabase —
    // verified empirically (agent_log #33). MCP and notebook editing stay blocked.
    expect(denied).toBe('mcp__*,NotebookEdit')
    expect(tools.split(',')).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']))
    expect(args).not.toContain('Chrome')
  })
})

describe('fixed goal-worker policy', () => {
  it('keeps exactly the health helper commands, plus the ctx.py instruction resolver', () => {
    expect(CHAT_ALLOWED_TOOLS).toEqual(EXPECTED_HEALTH_HELPERS)
    expect(CHAT_ALLOWED_TOOLS).toHaveLength(10)

    const args = buildGoalClaudeArgs('build it')
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']))
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(EXPECTED_HEALTH_HELPERS)
    expect(args).not.toContain('Edit')
    expect(args).not.toContain('Write')
  })

  it('keeps hooks and memory disabled', () => {
    const settings = settingsFrom(buildGoalClaudeArgs('build it'))
    expect(settings).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false })
  })
})

describe('Claude process integration contracts', () => {
  const chatSource = readFileSync(resolve(import.meta.dirname, '../chat.ts'), 'utf8')
  const builderConfig = readFileSync(
    resolve(import.meta.dirname, '../../../electron-builder.yml'),
    'utf8'
  )

  it('uses ignored stdin and piped output for streaming', () => {
    expect(CLAUDE_STREAM_STDIO).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('closes an available child stdin and tolerates an absent one', () => {
    let ended = 0
    closeChildStdin({ stdin: { end: () => ended++ } } as never)
    expect(ended).toBe(1)
    expect(() => closeChildStdin({ stdin: null } as never)).not.toThrow()
  })

  it('keeps the fixed goal builder wired to the goal subprocess', () => {
    expect(chatSource).toContain('buildGoalClaudeArgs(prompt)')
    expect(chatSource).toContain('closeChildStdin(child)')
  })

  it('packages only the Claude health skills while preserving Alke metadata', () => {
    expect(builderConfig).toContain('productName: Alke')
    expect(builderConfig).toContain('icon: build/icon.icns')
    expect(builderConfig).toMatch(
      /- from: \.\.\/chatctx\/\.claude\/skills\s+to: chatctx\/\.claude\/skills/
    )
    expect(builderConfig).not.toMatch(/from: \.\.\/chatctx\/\.claude\s*$/m)
  })
})

describe('Claude CLI failure events', () => {
  it('extracts the user-facing text from a structured authentication failure', () => {
    expect(
      extractClaudeCliFailure({
        type: 'assistant',
        error: 'authentication_failed',
        message: {
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }]
        }
      })
    ).toBe('Not logged in · Please run /login')
  })

  it('extracts a failed result when no assistant error text was emitted', () => {
    expect(
      extractClaudeCliFailure({
        type: 'result',
        is_error: true,
        result: 'Authentication failed'
      })
    ).toBe('Authentication failed')
  })

  it('ignores successful and ordinary assistant events', () => {
    expect(extractClaudeCliFailure({ type: 'result', is_error: false, result: 'OK' })).toBeNull()
    expect(
      extractClaudeCliFailure({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Normal reply' }] }
      })
    ).toBeNull()
  })
})
