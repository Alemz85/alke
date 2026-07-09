// The five semantic accent domains defined in DESIGN.md. Every domain-bound
// component (badges, hero metrics, chart series) takes one of these values
// so color usage stays centralized and auditable.
export type Domain = 'aerobic' | 'load' | 'recovery' | 'sessions' | 'flag'

export const DOMAIN_LABEL: Record<Domain, string> = {
  aerobic: 'Zone 2',
  load: 'Load',
  recovery: 'Recovery',
  sessions: 'Sessions',
  flag: 'Flag'
}
