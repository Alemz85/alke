import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Injury, InjuryLogEntry } from '@shared/types'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'
import './InjuriesView.css'

const STATUS_LABEL: Record<Injury['status'], string> = {
  active: 'Active',
  recovering: 'Recovering',
  resolved: 'Resolved'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function sourceLabel(source: string | null): string {
  if (source === 'user') return 'you'
  if (source === 'chat') return 'agent'
  return source ?? ''
}

function ProgressLog({ injuryId }: { injuryId: string }): ReactElement {
  const logQuery = useQuery({
    queryKey: ['injuries', 'log', injuryId],
    queryFn: () => window.api.getInjuryLog(injuryId),
    staleTime: 60_000
  })

  if (logQuery.isLoading) {
    return <p className="injury-log-empty">Loading log…</p>
  }
  const entries: InjuryLogEntry[] = logQuery.data ?? []
  if (entries.length === 0) {
    return <p className="injury-log-empty">No progress notes yet.</p>
  }

  return (
    <ol className="injury-log">
      {entries.map((e) => (
        <li key={e.id} className="injury-log-entry">
          <div className="injury-log-meta">
            <span className="injury-log-date tabular-nums">{formatDate(e.entry_date)}</span>
            {e.pain_level !== null && (
              <span className="injury-log-pain tabular-nums">pain {e.pain_level}/10</span>
            )}
            {e.source && <span className="injury-log-source">{sourceLabel(e.source)}</span>}
          </div>
          <p className="injury-log-note">{e.note}</p>
        </li>
      ))}
    </ol>
  )
}

function InjuryCard({ injury, defaultExpanded }: { injury: Injury; defaultExpanded: boolean }): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const isActive = injury.status === 'active'

  return (
    <div className={`injury-card${isActive ? ' injury-card--active' : ''}`}>
      <button
        className="injury-card-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          size={18}
          strokeWidth={1.5}
          className={`injury-card-chevron${expanded ? ' injury-card-chevron--open' : ''}`}
        />
        <h3 className={`injury-name${isActive ? ' injury-name--active' : ''}`}>{injury.name}</h3>
      </button>

      <div className="injury-badges">
        <span className="badge injury-badge-status">{STATUS_LABEL[injury.status]}</span>
        {injury.severity && (
          <span className="badge injury-badge-severity">{injury.severity}</span>
        )}
        {injury.body_area && <span className="injury-body-area">{injury.body_area}</span>}
      </div>

      {expanded && (
        <div className="injury-card-body">
          {injury.summary && <p className="injury-summary">{injury.summary}</p>}

          {injury.recovery_plan && (
            <section className="injury-section">
              <h4 className="injury-section-title">Recovery plan</h4>
              <div className="injury-markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{injury.recovery_plan}</Markdown>
              </div>
            </section>
          )}

          <section className="injury-section">
            <h4 className="injury-section-title">Progress log</h4>
            <ProgressLog injuryId={injury.id} />
          </section>
        </div>
      )}
    </div>
  )
}

export function InjuriesView(): ReactElement {
  const injuriesQuery = useQuery({
    queryKey: ['injuries', 'list'],
    queryFn: () => window.api.getInjuries(),
    staleTime: 60_000
  })

  const injuries = injuriesQuery.data ?? []
  const activeOrRecovering = injuries.filter((i) => i.status !== 'resolved')
  const history = injuries.filter((i) => i.status === 'resolved')

  return (
    <div className="view">
      <TabHeader eyebrow="Compiled by the analysis agent" title="Injuries" />
      <p className="injury-intro">
        Maintained by the analysis chat — mention pain, setbacks, or milestones there and they land here.
      </p>

      {injuries.length === 0 ? (
        <EmptyState message="No injuries logged. The chat agent maintains this section — tell it about a flare-up, a milestone, or ask it to compile your history." />
      ) : (
        <>
          {activeOrRecovering.length > 0 && (
            <section className="injury-group">
              <h2 className="injury-group-title">Active &amp; recovering</h2>
              <div className="injury-list">
                {activeOrRecovering.map((injury) => (
                  <InjuryCard key={injury.id} injury={injury} defaultExpanded />
                ))}
              </div>
            </section>
          )}

          {history.length > 0 && (
            <section className="injury-group">
              <h2 className="injury-group-title">History</h2>
              <div className="injury-list">
                {history.map((injury) => (
                  <InjuryCard key={injury.id} injury={injury} defaultExpanded={false} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
