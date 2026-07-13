// Activity icons per workout modality (lucide, matched by type substring —
// same matching philosophy as modalityAccent.ts). Fallback: generic pulse.
import type { ReactElement } from 'react'
import { Activity, Bike, Dumbbell, Footprints, Sailboat, Waves } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const ICON_RULES: [RegExp, LucideIcon][] = [
  [/swim/, Waves],
  [/cycl|bik/, Bike],
  [/row/, Sailboat],
  [/run|walk|hik/, Footprints],
  [/strength|weight|core|functional|gym|lift/, Dumbbell]
]

export function modalityIcon(type: string | null): LucideIcon {
  const t = (type ?? '').toLowerCase()
  const rule = ICON_RULES.find(([re]) => re.test(t))
  return rule ? rule[1] : Activity
}

export function ModalityIcon({
  type,
  size = 14,
  className
}: {
  type: string | null
  size?: number
  className?: string
}): ReactElement {
  const Icon = modalityIcon(type)
  return <Icon size={size} strokeWidth={1.75} className={className} aria-hidden="true" />
}
