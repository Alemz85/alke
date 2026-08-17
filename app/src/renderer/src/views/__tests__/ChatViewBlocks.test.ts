// Wiring tests for the AI chat "rich blocks" feature, in the same
// source-string-assertion house style as ChatView.test.ts: these check that
// the pieces are plugged together correctly (override present, the right
// props flow to the right turn), not runtime behavior — chatBlockParse.test.ts
// and chat/blocks/__tests__/blocks.render.test.ts cover that.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatViewSource = readFileSync(new URL('../ChatView.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const blocksCss = readFileSync(new URL('../chat/blocks/ChatBlocks.css', import.meta.url), 'utf8')
const rendererSource = readFileSync(new URL('../chat/blocks/ChatBlockRenderer.tsx', import.meta.url), 'utf8')
const parseSource = readFileSync(new URL('../chat/blocks/chatBlockParse.ts', import.meta.url), 'utf8')

describe('AssistantDocument — rich-block override', () => {
  it('overrides `pre` and dispatches through ChatBlockRenderer instead of a bare code fence', () => {
    expect(chatViewSource).toContain('pre: (')
    expect(chatViewSource).toContain('<ChatBlockRenderer')
    expect(chatViewSource).toContain('findCodeElement(node)')
    expect(chatViewSource).toContain('codeLanguage(codeNode)')
    expect(chatViewSource).toContain('hastTextContent(codeNode)')
  })

  it('keeps the existing table-scroll override untouched alongside the new one', () => {
    expect(chatViewSource).toContain('chat-table-scroll')
  })

  it('accepts streaming, block message context, and nav as props', () => {
    expect(chatViewSource).toMatch(/function AssistantDocument\(\{[\s\S]*?streaming = false[\s\S]*?\}/)
    expect(chatViewSource).toContain('blockContext?: ChatBlockMessageContext')
    expect(chatViewSource).toContain('nav?: ChatBlockNav')
  })
})

describe('MessageTurn — persisted messages pass real block context', () => {
  it('builds a ChatBlockMessageContext from the message, session, and index', () => {
    expect(chatViewSource).toMatch(/function MessageTurn\(\{[\s\S]*?sessionId[\s\S]*?messageIndex[\s\S]*?generationActive[\s\S]*?nav[\s\S]*?\}/)
    expect(chatViewSource).toContain('blockDecisions: message.blockDecisions')
    expect(chatViewSource).toContain('<AssistantDocument text={message.content} blockContext={blockContext} nav={nav} />')
  })

  it('threads sessionId, messageIndex, and generationActiveForSession from ChatView into each MessageTurn', () => {
    expect(chatViewSource).toContain('sessionId={state.selectedSessionId as string}')
    expect(chatViewSource).toContain('messageIndex={index}')
    expect(chatViewSource).toContain('generationActive={generationActiveForSession}')
  })
})

describe('RuntimeTurn — the live turn passes streaming and no decision context', () => {
  it('derives streaming from isChatRuntimeActive and passes it straight through', () => {
    expect(chatViewSource).toMatch(/function RuntimeTurn\(\{[\s\S]*?nav[\s\S]*?\}/)
    expect(chatViewSource).toContain('const streaming = isChatRuntimeActive(runtime)')
    expect(chatViewSource).toContain(
      '<AssistantDocument text={runtime.assistantText} streaming={streaming} nav={nav} />'
    )
  })

  it('never passes blockContext (no persisted session/message index exists yet for a live turn)', () => {
    const runtimeTurnBody = chatViewSource.slice(
      chatViewSource.indexOf('function RuntimeTurn'),
      chatViewSource.indexOf('function AssistantDocument')
    )
    expect(runtimeTurnBody).not.toContain('blockContext=')
  })
})

describe('ChatView — nav props degrade gracefully and thread down', () => {
  it('accepts onOpenSessions, onOpenGymTemplates, and onOpenInjuries as optional props', () => {
    expect(chatViewSource).toContain('onOpenSessions?: (activity?: string) => void')
    expect(chatViewSource).toContain('onOpenGymTemplates?: () => void')
    expect(chatViewSource).toContain('onOpenInjuries?: () => void')
  })

  it('builds one blockNav bundle and passes it to both MessageTurn and RuntimeTurn', () => {
    expect(chatViewSource).toContain(
      '({ onOpenSessions, onOpenGymTemplates, onOpenInjuries })'
    )
    expect(chatViewSource).toContain('nav={blockNav}')
  })
})

describe('App.tsx — wires the Chat tab to existing navigation closures', () => {
  it('passes openSessions, openGymTemplates, and a new openInjuries closure to ChatView', () => {
    expect(appSource).toContain('onOpenSessions={openSessions}')
    expect(appSource).toContain('onOpenGymTemplates={openGymTemplates}')
    expect(appSource).toContain('onOpenInjuries={openInjuries}')
  })

  it('openInjuries mirrors openGymTemplates by switching the active tab', () => {
    expect(appSource).toMatch(/const openInjuries = useCallback\(\(\): void => \{\s*setActiveTab\('injuries'\)/)
  })
})

describe('ChatBlockRenderer — dispatch table', () => {
  it('parses through chatBlockParse and covers all four block kinds plus the metric-registry gate', () => {
    expect(rendererSource).toContain('parseChatBlock(language, body, streaming)')
    expect(rendererSource).toContain("case 'workout':")
    expect(rendererSource).toContain("case 'metric':")
    expect(rendererSource).toContain("case 'template':")
    expect(rendererSource).toContain("case 'recovery-plan':")
    expect(rendererSource).toContain('resolveMetricDef(')
  })

  it('renders the caller-supplied fallback for not-a-block, invalid, and unknown-metric cases', () => {
    expect(rendererSource).toContain("result.status === 'not-a-block' || result.status === 'invalid'")
    expect(rendererSource).toContain('return fallback')
  })

  it('renders a skeleton for pending (streaming, not-yet-parseable) blocks', () => {
    expect(rendererSource).toContain("result.status === 'pending'")
    expect(rendererSource).toContain('<BlockSkeleton')
  })
})

describe('chatBlockParse — untrusted-payload validation surface', () => {
  it('recognizes exactly the four alke: block languages', () => {
    expect(parseSource).toContain("'alke:workout'")
    expect(parseSource).toContain("'alke:metric'")
    expect(parseSource).toContain("'alke:template'")
    expect(parseSource).toContain("'alke:recovery-plan'")
  })

  it('validates uuids, id charset, reps/secs xor, and the create-version/base rule', () => {
    expect(parseSource).toContain('UUID_RE')
    expect(parseSource).toContain('TEMPLATE_ID_RE')
    expect(parseSource).toContain('hasReps && hasSecs) return null')
    expect(parseSource).toContain("action === 'create-version'")
  })
})

describe('ChatBlocks.css — no shadows or gradients (DESIGN.md: elevation is luminance only)', () => {
  it('uses no shadows, gradients, or glows', () => {
    expect(blocksCss).not.toMatch(/linear-gradient|radial-gradient|box-shadow|filter:\s*drop-shadow/)
  })

  it('tokens only — no raw hex/rgb colors outside var(--…) references', () => {
    expect(blocksCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('respects prefers-reduced-motion for the skeleton shimmer and button transitions', () => {
    expect(blocksCss).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/)
  })
})
