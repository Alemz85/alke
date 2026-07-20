import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveChatWorkspace } from '../chatWorkspace'

async function fixture(gitMarker: 'directory' | 'file' = 'directory'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alke-workspace-'))
  await Promise.all([mkdir(join(root, 'app')), mkdir(join(root, 'chatctx'))])
  if (gitMarker === 'directory') await mkdir(join(root, '.git'))
  else await writeFile(join(root, '.git'), 'gitdir: /tmp/shared-git-dir\n')
  return root
}

describe('resolveChatWorkspace', () => {
  it('prefers and canonicalizes ALKE_REPO_ROOT', async () => {
    const root = await fixture()
    const alias = `${root}-alias`
    await symlink(root, alias)

    await expect(resolveChatWorkspace({ configuredRoot: alias })).resolves.toMatchObject({
      repoRoot: await realpath(root),
      source: 'configured'
    })
  })

  it('derives a development root from source chatctx', async () => {
    const root = await fixture()
    const canonicalRoot = await realpath(root)

    await expect(
      resolveChatWorkspace({ sourceChatctxDir: join(root, 'chatctx') })
    ).resolves.toMatchObject({ repoRoot: canonicalRoot, source: 'development' })
  })

  it('accepts a worktree .git file as a repository marker', async () => {
    const root = await fixture('file')
    const canonicalRoot = await realpath(root)

    await expect(resolveChatWorkspace({ configuredRoot: root })).resolves.toMatchObject({
      repoRoot: canonicalRoot,
      gitRoot: join(canonicalRoot, '.git')
    })
  })

  it('uses the validated owner fallback only for a packaged app', async () => {
    const root = await fixture()
    const canonicalRoot = await realpath(root)

    await expect(
      resolveChatWorkspace({ packaged: true, ownerFallback: root })
    ).resolves.toMatchObject({ repoRoot: canonicalRoot, source: 'owner-fallback' })
    await expect(resolveChatWorkspace({ ownerFallback: root })).rejects.toThrow(
      'repository not connected'
    )
  })

  it('rejects missing markers and never broadens to a parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alke-invalid-'))

    await expect(resolveChatWorkspace({ configuredRoot: root })).rejects.toThrow(
      'repository not connected'
    )
  })
})
