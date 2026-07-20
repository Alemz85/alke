import type { ChildProcess } from 'child_process'

export const CHAT_ALLOWED_TOOLS = [
  'Bash(python3 db.py:*)',
  'Bash(python db.py:*)',
  'Bash(python3 injuries.py:*)',
  'Bash(python3 goals.py:*)',
  'Bash(python3 agent_log.py:*)',
  'Bash(python3 gym.py:*)',
  'Bash(node recovery_plan_contract.mjs:*)',
  'Bash(node workout_template_contract.mjs:*)'
] as const

export const CLAUDE_STREAM_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']

function permissionArgs(): string[] {
  return ['--permission-mode', 'dontAsk', '--allowedTools', ...CHAT_ALLOWED_TOOLS]
}

export function buildStreamingClaudeArgs(prompt: string, resumeId?: string): string[] {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages'
  ]
  if (resumeId) args.push('--resume', resumeId)
  return [...args, ...permissionArgs()]
}

export function buildGoalClaudeArgs(prompt: string): string[] {
  return ['-p', prompt, ...permissionArgs()]
}

export function closeChildStdin(child: Pick<ChildProcess, 'stdin'>): void {
  child.stdin?.end()
}
