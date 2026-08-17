import type { ReactElement, ReactNode } from 'react'
import { Heart } from 'lucide-react'
import type { WorkoutBlockPayload } from './chatBlockParse'
import type { ChatBlockNav } from './chatBlockContext'
import { useUserConfig, useWorkoutDetail } from '../../../hooks/useSessionsData'
import { formatDateShort, formatTime } from '../../gym/gymFormat'
import { EM_DASH, formatClockDuration } from '../../../lib/format'
import { ModalityIcon } from '../../../components/ModalityIcon'
import { BadgeDomain } from '../../../components/BadgeDomain'
import { activityGroupLabel, modalityLabel, modalityToDomain } from '../../../components/modalityAccent'
import { Sparkline } from '../../../components/Sparkline'
import { BlockErrorChip, BlockSkeleton } from './BlockChrome'
import './ChatBlocks.css'

function Stat({ label, value, icon }: { label: string; value: string; icon?: ReactNode }): ReactElement {
  return (
    <div className="chat-block-stat">
      <span className="chat-block-stat-value tabular-nums">
        {icon}
        {value}
      </span>
      <span className="chat-block-stat-label">{label}</span>
    </div>
  )
}

export function WorkoutBlock({
  payload,
  nav
}: {
  payload: WorkoutBlockPayload
  nav: ChatBlockNav
}): ReactElement {
  const detailQuery = useWorkoutDetail(payload.workout_id)
  const configQuery = useUserConfig()

  if (detailQuery.isLoading) return <BlockSkeleton label="Loading workout…" />
  if (detailQuery.isError || !detailQuery.data) {
    return <BlockErrorChip message="Couldn't load that workout" />
  }

  const { workout, hrSamples, computed } = detailQuery.data
  const timezone = configQuery.data?.timezone
  const rawDomain = modalityToDomain(workout.type)
  const domain = rawDomain === 'neutral' ? 'sessions' : rawDomain
  const distanceKm = workout.distance_m != null ? (workout.distance_m / 1000).toFixed(2) : null
  const hrIcon = <Heart size={12} strokeWidth={1.8} className="chat-block-stat-hr-icon" aria-hidden="true" />
  const sparklinePoints = hrSamples.map((sample) => ({ x: sample.offset_s, y: sample.bpm }))

  return (
    <div className="chat-block chat-block--workout">
      <div className="chat-block-head">
        <div className="chat-block-head-badge">
          <ModalityIcon type={workout.type} size={16} />
          <BadgeDomain domain={domain} label={payload.label || modalityLabel(workout.type)} />
        </div>
        <span className="chat-block-head-datetime tabular-nums">
          {formatDateShort(workout.start_at, timezone)} · {formatTime(workout.start_at, timezone)}
        </span>
      </div>

      {sparklinePoints.length >= 2 && (
        <div className="chat-block-workout-trace">
          <Sparkline
            points={sparklinePoints}
            domain={domain}
            ariaLabel={`Heart rate trace, ${sparklinePoints.length} samples`}
            height={40}
          />
        </div>
      )}

      <div className="chat-block-stats">
        <Stat label="Duration" value={formatClockDuration(workout.duration_s ?? 0)} />
        {distanceKm && <Stat label="Distance" value={`${distanceKm} km`} />}
        <Stat
          label="Avg HR"
          value={workout.avg_hr != null ? `${Math.round(workout.avg_hr)} bpm` : EM_DASH}
          icon={workout.avg_hr != null ? hrIcon : undefined}
        />
        <Stat label="Max HR" value={workout.max_hr != null ? `${Math.round(workout.max_hr)} bpm` : EM_DASH} />
        <Stat label="TRIMP" value={computed?.trimp != null ? String(Math.round(computed.trimp)) : EM_DASH} />
      </div>

      {nav.onOpenSessions && (
        <button
          type="button"
          className="chat-block-footer-link"
          onClick={() => nav.onOpenSessions?.(activityGroupLabel(workout.type))}
        >
          View in Sessions →
        </button>
      )}
    </div>
  )
}
