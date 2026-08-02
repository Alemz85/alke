import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../InsightsView.tsx', import.meta.url), 'utf8')

describe('Insights inference policy', () => {
  it('keeps technique-confounded swim EF out of inferential views', () => {
    const perfOptions = source.match(/const PERFS = \[[\s\S]*?\n\]/)?.[0] ?? ''
    const perfAccumulator = source.match(/const perfAcc:[\s\S]*?\n[ ]{4}}/)?.[0] ?? ''

    expect(perfOptions).not.toContain("key: 'ef'")
    expect(perfAccumulator).not.toContain('ef: new Map()')
    expect(source).toContain("model.name !== 'ef_on_sleep_dlm'")
    expect(source).toContain("candidate.outcome !== 'ef'")
    expect(source).toContain("correlation.var_y !== 'ef'")
    expect(source).toContain('insightWindowStart(selected.computed_at, timezone)')
    expect(source).toContain("{ key: 'trimp_total', label: 'Workout-day load' }")
    expect(source).toContain("selected.var_y === 'trimp_total'")
    expect(source).toContain('Load relationships are waiting for the next metrics recompute')
    expect(source).not.toContain('finderDiagnostics.candidate_count ?? finderCandidates.length')
  })

  it('surfaces the expanded daily and workout-context inference contracts', () => {
    expect(source).toContain("key: 'sleep_shortfall'")
    expect(source).toContain("key: 'sleep_awake_fraction'")
    expect(source).toContain("key: 'respiratory_rate_dev'")
    expect(source).toContain("key: 'steps_prior'")
    expect(source).toContain("key: 'weight_7d_slope'")
    expect(source).toContain("model.name === 'workout_context_finder'")
    expect(source).toContain("model.name !== 'workout_context_finder'")
    expect(source).toContain('diagnostics?.model_version === family.expectedVersion')
    expect(source).toContain('waitingForExpandedRecompute')
    expect(source).toContain('Block-bootstrap stability')
    expect(source).toContain('Seven-night persistence')
    expect(source).toContain('Null calibration:')
    expect(source).toContain('insightAxis(')
  })
})
