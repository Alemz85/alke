import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'

export interface ChatWorkspaceOptions {
  configuredRoot?: string
  sourceChatctxDir?: string
  packaged?: boolean
  ownerFallback?: string
}

export interface ChatWorkspace {
  repoRoot: string
  appRoot: string
  gitRoot: string
  chatctxRoot: string
  source: 'configured' | 'development' | 'owner-fallback'
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function validateCandidate(
  candidate: string,
  source: ChatWorkspace['source']
): Promise<ChatWorkspace | null> {
  if (!isAbsolute(candidate)) return null

  try {
    const repoRoot = await realpath(candidate)
    if (repoRoot === parse(repoRoot).root) return null

    const appRoot = join(repoRoot, 'app')
    const gitRoot = join(repoRoot, '.git')
    const chatctxRoot = join(repoRoot, 'chatctx')
    const [hasApp, hasGit, hasChatctx] = await Promise.all([
      isDirectory(appRoot),
      exists(gitRoot),
      isDirectory(chatctxRoot)
    ])
    if (!hasApp || !hasGit || !hasChatctx) return null

    return { repoRoot, appRoot, gitRoot, chatctxRoot, source }
  } catch {
    return null
  }
}

export async function resolveChatWorkspace(
  options: ChatWorkspaceOptions
): Promise<ChatWorkspace> {
  const candidates: Array<[string | undefined, ChatWorkspace['source']]> = [
    [options.configuredRoot, 'configured'],
    [options.sourceChatctxDir ? join(options.sourceChatctxDir, '..') : undefined, 'development'],
    [options.packaged ? options.ownerFallback : undefined, 'owner-fallback']
  ]

  for (const [candidate, source] of candidates) {
    if (!candidate) continue
    const workspace = await validateCandidate(candidate, source)
    if (workspace) return workspace
  }

  throw new Error(
    'Sports app repository not connected. Set ALKE_REPO_ROOT to its absolute path.'
  )
}
