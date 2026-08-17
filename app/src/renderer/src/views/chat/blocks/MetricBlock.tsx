import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ComputedDaily, DailyMetric } from '@shared/types'
import type { MetricBlockPayload } from './chatBlockParse'
import type { MetricDef } from './metricRegistry'
import { useUserConfig } from '../../../hooks/useSessionsData'
import { addDays, todayYMD, ymdKey } from '../../../hooks/sessionsDate'
import { EM_DASH } from '../../../lib/format'
import { MetricCard } from '../../../components/MetricCard'
import { Sparkline, type SparklinePoint } from '../../../components/Sparkline'
import { BlockErrorChip, BlockSkeleton } from './BlockChrome'
import './ChatBlocks.css'

/** Days-since-epoch for a 'YYYY-MM-DD' date key — the real time axis Sparkline expects. */
function daysSinceEpoch(dateKey: string): number {
  return Math.floor(new Date(`${dateKey}T00:00:00Z`).getTime() / 86_400_000)
}

function readField(row: Record<string, unknown>, field: string): number | null {
  const value = row[field]
  return typeof value === 'number' ? value : null
}

/** Signed delta in the metric's own raw unit. def.format already renders a
 *  leading "-" for negative numbers, so the sign prefix only needs +/± —
 *  the one exception is sleep_duration_min's h:mm formatter, which is not
 *  negative-safe, so a delta there is shown in plain minutes instead. */
function formatSignedDelta(rawDelta: number, def: MetricDef): string {
  if (def.field === 'sleep_duration_min') {
    const sign = rawDelta > 0 ? '+' : rawDelta < 0 ? '-' : '±'
    return `${sign}${Math.round(Math.abs(rawDelta))}m`
  }
  const sign = rawDelta > 0 ? '+' : rawDelta < 0 ? '' : '±'
  return `${sign}${def.format(rawDelta)}`
}

export function MetricBlock({
  payload,
  def
}: {
  payload: MetricBlockPayload
  def: MetricDef
}): ReactElement {
  const configQuery = useUserConfig()
  const timezone = configQuery.data?.timezone
  const today = todayYMD(timezone)
  const fromDate = ymdKey(addDays(today, -(payload.days - 1)))
  const toDate = ymdKey(today)

  const dailyQuery = useQuery<DailyMetric[]>({
    queryKey: ['health', 'dailyMetrics', fromDate, toDate],
    queryFn: () => window.api.getDailyMetrics(fromDate, toDate),
    enabled: def.source === 'daily',
    staleTime: 60_000
  })
  const computedQuery = useQuery<ComputedDaily[]>({
    queryKey: ['chatBlock', 'computedDaily', fromDate, toDate],
    queryFn: () => window.api.getComputedDaily(fromDate, toDate),
    enabled: def.source === 'computed',
    staleTime: 60_000
  })

  const activeQuery = def.source === 'daily' ? dailyQuery : computedQuery

  const eyebrow = payload.label || def.label

  if (activeQuery.isLoading) return <BlockSkeleton label={`Loading ${eyebrow}…`} />
  if (activeQuery.isError) return <BlockErrorChip message={`Couldn't load ${eyebrow}`} />

  const rows = (activeQuery.data ?? []) as unknown as Array<Record<string, unknown> & { date: string }>
  const points: { date: string; value: number }[] = []
  for (const row of rows) {
    const value = readField(row, def.field)
    if (value != null) points.push({ date: row.date, value })
  }

  const latest = points.length > 0 ? points[points.length - 1] : null
  const first = points.length > 0 ? points[0] : null
  const delta = latest && first && points.length > 1 ? latest.value - first.value : null

  const sparklinePoints: SparklinePoint[] = points.map((p) => ({ x: daysSinceEpoch(p.date), y: p.value }))
  const value = latest ? def.format(latest.value) : EM_DASH
  const caption =
    points.length === 0
      ? `No data in the last ${payload.days}d.`
      : delta != null
        ? `${payload.days}d · ${formatSignedDelta(delta, def)}`
        : `${payload.days}d`

  return (
    <div className="chat-block chat-block--metric">
      <MetricCard
        eyebrow={eyebrow}
        value={value}
        domain={def.domain}
        caption={caption}
        sparkline={
          sparklinePoints.length >= 2 ? (
            <Sparkline
              points={sparklinePoints}
              domain={def.domain ?? 'sessions'}
              ariaLabel={`${eyebrow} over the last ${payload.days} days`}
            />
          ) : undefined
        }
      />
    </div>
  )
}
