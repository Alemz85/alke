import type { GymSession, Workout } from '@shared/types'

/** A synced strength workout (logged or not), or a standalone Gym log. */
export interface GymSessionItem {
  key: string
  workout: Workout | null
  session: GymSession | null
  dateIso: string
  logged: boolean
}
