// Blood panels on the Profile tab — the owner's own lab results, read-only.
//
// Deliberately a plain reference table, not a dashboard. These are clinical
// numbers the app does not interpret: out-of-range markers are marked because
// the REPORT marked them (or because the value sits outside the range the report
// itself printed), never because this code formed a judgement. See
// chatctx/modes/_shared.md for the matching rule on the chat side.
import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { BloodMarker, BloodPanel } from '@shared/types'
import { groupByCategory, markerValue, panelAgeLabel } from '../../lib/bloodPanels'
import { EmptyState } from '../../components'
import './BloodPanelsSection.css'

function MarkerRow({ marker }: { marker: BloodMarker }): ReactElement {
  const flagged = marker.flag === 'low' || marker.flag === 'high' || marker.flag === 'abnormal'
  return (
    <tr className={flagged ? 'blood-row blood-row--flagged' : 'blood-row'}>
      <th scope="row" className="blood-cell-name">
        {marker.label_raw}
      </th>
      <td className="blood-cell-value tabular-nums">
        {markerValue(marker)}
        {marker.unit && <span className="blood-unit"> {marker.unit}</span>}
      </td>
      <td className="blood-cell-ref">{marker.ref_text ?? '—'}</td>
      <td className="blood-cell-flag">
        {flagged && (
          <span className={`blood-flag blood-flag--${marker.flag}`}>
            {marker.flag === 'low' ? 'low' : marker.flag === 'high' ? 'high' : 'flagged'}
          </span>
        )}
      </td>
    </tr>
  )
}

function PanelCard({ panel, now }: { panel: BloodPanel; now: Date }): ReactElement {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => groupByCategory(panel.markers), [panel.markers])
  const flagged = panel.markers.filter(
    (m) => m.flag === 'low' || m.flag === 'high' || m.flag === 'abnormal'
  )
  const ageLabel = panelAgeLabel(panel.collected_on, now)

  return (
    <div className="blood-panel">
      <button
        type="button"
        className="blood-panel-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={15} strokeWidth={2} /> : <ChevronRight size={15} strokeWidth={2} />}
        <span className="blood-panel-title">
          <span className="blood-panel-name">{panel.panel_name}</span>
          <span className="blood-panel-meta">
            {panel.collected_on}
            {panel.lab && ` · ${panel.lab}`}
          </span>
          {ageLabel && <span className="blood-panel-age">{ageLabel}</span>}
        </span>
        <span className="blood-panel-count">
          {panel.markers.length} markers
          {flagged.length > 0 && (
            <span className="blood-panel-flagged"> · {flagged.length} outside range</span>
          )}
        </span>
      </button>

      {open && (
        <div className="blood-panel-body">
          {groups.map(([category, markers]) => (
            <div key={category} className="blood-group">
              <h5 className="blood-group-title">{category}</h5>
              <table className="blood-table">
                <thead>
                  <tr>
                    <th scope="col">Marker</th>
                    <th scope="col">Result</th>
                    <th scope="col">Reference</th>
                    <th scope="col">
                      <span className="sr-only">Flag</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {markers.map((m) => (
                    <MarkerRow key={m.id} marker={m} />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {panel.notes && <p className="blood-panel-notes">{panel.notes}</p>}
        </div>
      )}
    </div>
  )
}

export function BloodPanelsSection({ now }: { now: Date }): ReactElement {
  const panelsQuery = useQuery({
    queryKey: ['bloodPanels'],
    queryFn: () => window.api.getBloodPanels(),
    staleTime: 300_000
  })
  const panels = panelsQuery.data ?? []

  return (
    <section className="profile-section">
      <h3 className="profile-section-title">Blood panels</h3>
      {panelsQuery.isLoading ? (
        <p className="profile-loading">Loading…</p>
      ) : panelsQuery.isError ? (
        <p className="profile-error">Could not load blood panels.</p>
      ) : panels.length === 0 ? (
        <EmptyState message="No lab results yet. Import one with scripts/import_blood_panel.py." />
      ) : (
        <>
          <div className="blood-panels">
            {panels.map((panel) => (
              <PanelCard key={panel.id} panel={panel} now={now} />
            ))}
          </div>
          <p className="blood-disclaimer">
            Your own lab results, shown as recorded. Out-of-range marks come from the report or
            its printed reference range — nothing here is interpreted or diagnostic. Discuss
            anything flagged with a doctor.
          </p>
        </>
      )}
    </section>
  )
}
