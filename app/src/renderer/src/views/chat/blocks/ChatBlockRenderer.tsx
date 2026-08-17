import type { ReactElement } from 'react'
import { parseChatBlock } from './chatBlockParse'
import { resolveMetricDef } from './metricRegistry'
import type { ChatBlockMessageContext, ChatBlockNav } from './chatBlockContext'
import { BlockSkeleton } from './BlockChrome'
import { WorkoutBlock } from './WorkoutBlock'
import { MetricBlock } from './MetricBlock'
import { TemplateProposalBlock } from './TemplateProposalBlock'
import { RecoveryPlanProposalBlock } from './RecoveryPlanProposalBlock'

/**
 * Dispatches one fenced code block to its card, given the already-extracted
 * (language, body) pair from AssistantDocument's `pre` override. `fallback`
 * is the default `<pre><code>…</code></pre>` react-markdown would have
 * rendered — used verbatim whenever this isn't (or isn't yet, or isn't
 * validly) one of our block types, so every other code block is pixel-
 * identical to today's rendering.
 */
export function ChatBlockRenderer({
  language,
  body,
  streaming,
  fallback,
  messageContext,
  nav
}: {
  language: string
  body: string
  streaming: boolean
  fallback: ReactElement
  messageContext?: ChatBlockMessageContext
  nav: ChatBlockNav
}): ReactElement {
  const result = parseChatBlock(language, body, streaming)

  if (result.status === 'not-a-block' || result.status === 'invalid') return fallback
  if (result.status === 'pending') return <BlockSkeleton label="Preparing…" />

  switch (result.block.kind) {
    case 'workout':
      return <WorkoutBlock payload={result.block.payload} nav={nav} />
    case 'metric': {
      const def = resolveMetricDef(result.block.payload.metric)
      if (!def) return fallback
      return <MetricBlock payload={result.block.payload} def={def} />
    }
    case 'template':
      return (
        <TemplateProposalBlock
          payload={result.block.payload}
          streaming={streaming}
          messageContext={messageContext}
        />
      )
    case 'recovery-plan':
      return (
        <RecoveryPlanProposalBlock
          payload={result.block.payload}
          streaming={streaming}
          messageContext={messageContext}
          nav={nav}
        />
      )
    default: {
      const exhaustive: never = result.block
      return exhaustive
    }
  }
}
