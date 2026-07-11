// Cardio-fitness index trajectory: the nightly model's last 150 days as index
// line + honest confidence band. Fetches with the same query key/window as
// Zone2FitnessHeader, so the two share one cached response.
import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Zone2Fitness } from '@shared/types'
import { addDays, todayYMD } from '../hooks/sessionsDate'
import { zone2IndexValue } from '../lib/zone2Fitness'
import './Zone2Trajectory.css'

interface Props {
  timezone: string | null
}

export function Zone2Trajectory({ timezone }: Props): ReactElement {
  const today = useMemo(() => todayYMD(timezone), [timezone])
  const { fromDate, toDate } = useMemo(() => {
    const from = addDays(today, -150)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return {
      fromDate: `${from.year}-${pad(from.month)}-${pad(from.day)}`,
      toDate: `${today.year}-${pad(today.month)}-${pad(today.day)}`
    }
  }, [today])

  const fitnessQuery = useQuery<Zone2Fitness[]>({
    queryKey: ['zone2-fitness', fromDate, toDate],
    queryFn: () => window.api.getZone2Fitness(fromDate, toDate),
    staleTime: 60_000
  })

  const data = useMemo(
    () =>
      (fitnessQuery.data ?? [])
        .filter((r) => r.durable_base != null)
        .map((r) => ({
          date: r.date.slice(5),
          index: zone2IndexValue(r),
          band:
            r.durable_band_lo != null && r.durable_band_hi != null
              ? [r.durable_band_lo, r.durable_band_hi]
              : null
        })),
    [fitnessQuery.data]
  )

  if (data.length < 2) {
    return (
      <p className="z2traj-empty">
        The trajectory draws here once the nightly model has a few days of history.
      </p>
    )
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -24 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
            axisLine={false}
            tickLine={false}
            minTickGap={36}
          />
          <YAxis
            domain={[0, (dataMax: number) => Math.max(40, Math.ceil((dataMax * 1.25) / 10) * 10)]}
            tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface-hover)',
              border: 'none',
              borderRadius: 12,
              fontSize: 13,
              fontVariantNumeric: 'tabular-nums'
            }}
            formatter={(v, name) =>
              name === 'band'
                ? [
                    Array.isArray(v)
                      ? `${Math.round(Number(v[0]))}–${Math.round(Number(v[1]))}`
                      : v,
                    'band'
                  ]
                : [typeof v === 'number' ? Math.round(v) : v, 'index']
            }
          />
          <Area dataKey="band" stroke="none" fill="var(--color-aerobic-dim)" isAnimationActive={false} />
          <Line
            dataKey="index"
            stroke="var(--color-aerobic)"
            strokeWidth={1.5}
            dot={false}
            type="monotone"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <p className="z2traj-caption">
        Line is the index; the shaded band is its honest uncertainty. Direction matters more than
        the number.
      </p>
    </>
  )
}
