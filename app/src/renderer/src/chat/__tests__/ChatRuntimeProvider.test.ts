import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const providerSource = readFileSync(
  resolve(import.meta.dirname, '../ChatRuntimeProvider.tsx'),
  'utf8'
)
const appSource = readFileSync(resolve(import.meta.dirname, '../../App.tsx'), 'utf8')

describe('ChatRuntimeProvider architecture', () => {
  it('mounts above the app tab switch rather than inside ChatView', () => {
    expect(appSource).toContain("import { ChatRuntimeProvider } from './chat/ChatRuntimeProvider'")
    expect(appSource).toMatch(
      /<ChatRuntimeProvider>[\s\S]*renderActiveView\(\)[\s\S]*<\/ChatRuntimeProvider>/
    )
  })

  it('owns the single stream subscription and reconciles the main snapshot', () => {
    expect(providerSource).toContain('window.api.onChatStream')
    expect(providerSource).toContain('window.api.chatGetRuntime()')
    expect(providerSource).toContain("type: 'hydrate-runtime'")
    expect(providerSource).toContain("type: 'runtime-event'")
  })

  it('persists UI composition state separately from the runtime snapshot', () => {
    expect(providerSource).toContain('CHAT_UI_STORAGE_KEY')
    expect(providerSource).toContain('serializeChatUiState(state)')
    expect(providerSource).toContain('chatValidateAttachments([path])')
  })

  it('keeps rejected sends recoverable', () => {
    const sendSource = providerSource.match(
      /const send = useCallback\([\s\S]*?const stop = useCallback/
    )?.[0]
    expect(sendSource).toBeDefined()
    expect(sendSource).toContain('await window.api.chatSend')
    expect(sendSource).toContain("type: 'promote-composition'")
    expect(sendSource).toContain("type: 'set-notice'")
  })
})
