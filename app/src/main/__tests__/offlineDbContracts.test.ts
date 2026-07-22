import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')

describe('offline write idempotency contracts', () => {
  it('ships a receipt-backed exactly-once protein delta RPC', () => {
    const migrationPath = resolve(
      root,
      'supabase/migrations/20260713170000_offline_write_idempotency.sql'
    )
    expect(existsSync(migrationPath)).toBe(true)
    const sql = readFileSync(migrationPath, 'utf8')
    expect(sql).toContain('create table offline_mutation_receipts')
    expect(sql).toContain('function apply_protein_delta')
    expect(sql).toContain('on conflict (id) do nothing')
    expect(sql).toContain('protein_log.grams + excluded.grams')

    const ambiguityFix = readFileSync(
      resolve(root, 'supabase/migrations/20260713171000_fix_protein_delta_ambiguity.sql'),
      'utf8'
    )
    expect(ambiguityFix).toContain('on conflict on constraint protein_log_pkey')
    expect(ambiguityFix).toContain('from protein_log as p')
  })

  it('accepts stable mutation ids for retry-safe create operations', () => {
    const source = readFileSync(resolve(root, 'app/src/main/db.ts'), 'utf8')

    expect(source).toMatch(/addInjuryLog\([\s\S]*mutationId: string/)
    expect(source).toMatch(/addGymTemplate\([\s\S]*mutationId: string/)
    expect(source).toMatch(/addGymSession\([\s\S]*mutationId: string/)
    expect(source).toMatch(/addProtein\([\s\S]*mutationId: string/)
    expect(source).toContain(".rpc('apply_protein_delta'")
  })

  it('replaces gym-session sets atomically so a failed insert preserves the previous log', () => {
    const migrationPath = resolve(
      root,
      'supabase/migrations/20260722220000_atomic_gym_set_replacement.sql'
    )
    expect(existsSync(migrationPath)).toBe(true)

    const sql = readFileSync(migrationPath, 'utf8')
    expect(sql).toContain('function replace_gym_session_sets')
    expect(sql).toContain('delete from gym_sets')
    expect(sql).toContain('jsonb_array_elements(p_sets) with ordinality')
    expect(sql).toContain('grant execute on function replace_gym_session_sets(uuid, jsonb) to service_role')

    const source = readFileSync(resolve(root, 'app/src/main/db.ts'), 'utf8')
    const update = source.match(/export async function updateGymSession[\s\S]*?\n}\n\nexport async function deleteGymSession/)?.[0] ?? ''
    expect(source).toContain(".rpc('replace_gym_session_sets'")
    expect(update).toContain('replaceGymSetsAtomically(id, patch.sets)')
    expect(update).not.toContain(".from('gym_sets').delete()")
    expect(update).not.toContain('insertGymSets(id, patch.sets)')
  })
})
