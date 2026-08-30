import type { ChildProcess } from 'child_process'
import { relative } from 'path'

export const CHAT_ALLOWED_TOOLS = [
  'Bash(python3 db.py:*)',
  'Bash(python db.py:*)',
  'Bash(python3 injuries.py:*)',
  'Bash(python3 goals.py:*)',
  'Bash(python3 agent_log.py:*)',
  'Bash(python3 session.py:*)',
  'Bash(python3 gym.py:*)',
  'Bash(node recovery_plan_contract.mjs:*)',
  'Bash(node workout_template_contract.mjs:*)'
] as const

export const CLAUDE_STREAM_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']

const CHAT_MODEL_ARGS = ['--model', 'claude-opus-5', '--effort', 'high']

export interface ChatPolicyPaths {
  repoRoot: string
  appRoot: string
  gitRoot: string
  runtimeRoot: string
  homeRoot: string
  attachmentPaths: string[]
}

function absoluteRulePath(path: string): string {
  return `//${path.replace(/^\/+/, '')}`
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !pathFromParent.startsWith('/'))
  )
}

export function buildInteractiveSettings(paths: ChatPolicyPaths): Record<string, unknown> {
  const repo = absoluteRulePath(paths.repoRoot)
  const app = absoluteRulePath(paths.appRoot)
  const git = absoluteRulePath(paths.gitRoot)
  const home = absoluteRulePath(paths.homeRoot)
  const envRulePaths = [`${repo}/.env*`, `${repo}/**/.env*`]
  const denyWrite = [
    paths.appRoot,
    paths.gitRoot,
    `${paths.repoRoot}/.env*`,
    `${paths.repoRoot}/**/.env*`
  ]
  if (!isInside(paths.repoRoot, paths.runtimeRoot)) denyWrite.push(paths.runtimeRoot)

  return {
    permissions: {
      allow: [
        `Read(${repo}/**)`,
        `Edit(${repo}/**)`,
        `Write(${repo}/**)`,
        ...paths.attachmentPaths.map((path) => `Read(${absoluteRulePath(path)})`),
        'Bash',
        'Skill',
        'WebSearch',
        'WebFetch'
      ],
      deny: [
        `Edit(${app}/**)`,
        `Write(${app}/**)`,
        `Edit(${git}/**)`,
        `Write(${git}/**)`,
        ...envRulePaths.flatMap((path) => [
          `Read(${path})`,
          `Edit(${path})`,
          `Write(${path})`
        ]),
        `Read(${home}/.ssh/**)`,
        `Read(${home}/.aws/**)`,
        `Read(${home}/.claude/**)`,
        `Read(${home}/.config/gcloud/**)`,
        `Read(${home}/Library/Keychains/**)`,
        `Read(${home}/Library/Application Support/Google/Chrome/**)`
      ]
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        allowWrite: [paths.repoRoot],
        denyWrite,
        denyRead: [paths.homeRoot, `${paths.repoRoot}/.env*`, `${paths.repoRoot}/**/.env*`],
        allowRead: [paths.repoRoot, ...paths.attachmentPaths]
      },
      network: {
        allowedDomains: ['your-project-ref.supabase.co']
      }
    },
    disableAllHooks: true,
    autoMemoryEnabled: false
  }
}

function fixedHealthPermissionArgs(): string[] {
  const inlineSettings = JSON.stringify({
    permissions: { allow: CHAT_ALLOWED_TOOLS },
    disableAllHooks: true,
    autoMemoryEnabled: false
  })

  return [
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'project',
    '--settings',
    inlineSettings,
    '--tools',
    'Read,Glob,Grep,Bash,Skill',
    '--strict-mcp-config',
    '--disallowedTools',
    'mcp__*',
    '--allowedTools',
    ...CHAT_ALLOWED_TOOLS
  ]
}

export function buildStreamingClaudeArgs(
  prompt: string,
  resumeId?: string,
  paths?: ChatPolicyPaths
): string[] {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...CHAT_MODEL_ARGS
  ]
  if (resumeId) args.push('--resume', resumeId)
  if (!paths) return [...args, ...fixedHealthPermissionArgs()]

  return [
    ...args,
    '--permission-mode',
    'acceptEdits',
    '--setting-sources',
    'project',
    '--settings',
    JSON.stringify(buildInteractiveSettings(paths)),
    '--tools',
    // WebSearch/WebFetch run server-side over the Anthropic API connection the CLI
    // already holds open, so they work even though the sandbox network allowlist below
    // only permits the Supabase host (verified empirically — see agent_log #33).
    'Read,Glob,Grep,Edit,Write,Bash,Skill,WebSearch,WebFetch',
    '--add-dir',
    paths.repoRoot,
    '--strict-mcp-config',
    '--disallowedTools',
    'mcp__*,NotebookEdit'
  ]
}

export function buildGoalClaudeArgs(prompt: string): string[] {
  return ['-p', prompt, ...CHAT_MODEL_ARGS, ...fixedHealthPermissionArgs()]
}

export function closeChildStdin(child: Pick<ChildProcess, 'stdin'>): void {
  child.stdin?.end()
}

/** Read user-facing failures that Claude emits as stream JSON instead of stderr. */
export function extractClaudeCliFailure(event: Record<string, unknown>): string | null {
  if (event.type === 'assistant' && typeof event.error === 'string') {
    const content = (event.message as { content?: unknown[] } | undefined)?.content ?? []
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text.trim()
      }
    }
  }
  if (event.type === 'result' && event.is_error === true && typeof event.result === 'string') {
    return event.result.trim() || null
  }
  return null
}
