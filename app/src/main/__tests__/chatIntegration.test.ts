import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../shared/types'

const chatSource = readFileSync(resolve(import.meta.dirname, '../chat.ts'), 'utf8')
const indexSource = readFileSync(resolve(import.meta.dirname, '../index.ts'), 'utf8')
const preloadSource = readFileSync(resolve(import.meta.dirname, '../../preload/index.ts'), 'utf8')

describe('persistent chat main-process integration', () => {
  it('declares runtime, continuation, and stream IPC channels', () => {
    expect(IPC_CHANNELS).toMatchObject({
      chatGetRuntime: 'chat:getRuntime',
      chatContinue: 'chat:continue',
      chatStream: 'chat:stream'
    })
  })

  it('records text before broadcasting its sequenced envelope', () => {
    expect(chatSource).toMatch(
      /const envelope = runtime\.appendText\([^)]+\)[\s\S]*emitEnvelope\(window, envelope\)/
    )
  })

  it('returns generation ownership and enforces one active child', () => {
    expect(chatSource).toContain('generationId')
    expect(chatSource).toContain('A chat response is already running.')
    expect(chatSource).toContain('let activeChild')
    expect(chatSource).not.toContain('MAX_CONCURRENT_CHILDREN')
    expect(chatSource).not.toContain('killOtherSessions')
  })

  it('resolves canonical workspace policy paths before spawning Claude', () => {
    expect(chatSource).toContain('resolveChatWorkspace')
    expect(chatSource).toContain('ALKE_REPO_ROOT')
    expect(chatSource).toMatch(
      /buildStreamingClaudeArgs\(\s*prompt,\s*session\.claude_session_id[\s\S]*?policyPaths\s*\)/
    )
    expect(chatSource).toContain('policyPaths')
  })

  it('exposes snapshot and continuation through main and preload', () => {
    expect(indexSource).toContain('IPC_CHANNELS.chatGetRuntime')
    expect(indexSource).toContain('IPC_CHANNELS.chatContinue')
    expect(preloadSource).toContain(
      'chatGetRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.chatGetRuntime)'
    )
    expect(preloadSource).toContain(
      'chatContinue: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatContinue, sessionId)'
    )
  })

  it('flushes an interruption before killing Claude during quit', () => {
    expect(chatSource).toMatch(
      /app\.on\('before-quit',[\s\S]*runtime\.dispose\(true\)[\s\S]*child\.kill\('SIGTERM'\)/
    )
  })

  it('blocks deletion of the actively running session', () => {
    expect(chatSource).toContain('Cannot delete a conversation while its response is running.')
  })
})
