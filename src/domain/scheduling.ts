import type { PracticeSettings } from './review'
import type { LearningStrategy } from './progressive-learning'

export const MINUTE = 60_000
export const INTERVAL_PRESETS = [5, 15, 30, 60, 120] as const
export const QUESTION_PRESETS = [1, 3, 5, 10] as const
export const SNOOZE_MINUTES = [5, 10, 30, 60] as const
export const PAUSE_OPTIONS = [30, 60, 120, 'tomorrow'] as const
export type PauseOption = (typeof PAUSE_OPTIONS)[number]
export type SessionMode = 'study' | 'practice' | 'learn'

export interface ReminderSettings {
  sessionMode?: SessionMode
  strategy?: LearningStrategy
  practice?: PracticeSettings
  enabled: boolean
  intervalMinutes: number
  questionsPerSession: number
  mode: 'notification' | 'popup'
  focusPopup: boolean
  avoidFullscreen: boolean
  avoidIdle: boolean
  quietHours: { start: number; end: number } | null
}

export const DEFAULT_REMINDER_SETTINGS: Readonly<ReminderSettings> = {
  enabled: true,
  intervalMinutes: 30,
  questionsPerSession: 3,
  mode: 'notification',
  focusPopup: false,
  avoidFullscreen: false,
  avoidIdle: true,
  quietHours: null,
}

export type SchedulerPhase = 'STOPPED' | 'WAITING' | 'DUE' | 'SESSION_ACTIVE' | 'SNOOZED' | 'PAUSED'
export type SessionStage = 'pending' | 'active' | 'snoozed'

export function schedulerPhase(
  enabled: boolean,
  pauseUntil: number | null,
  stage: SessionStage | undefined,
): SchedulerPhase {
  if (!enabled) return 'STOPPED'
  if (pauseUntil !== null) return 'PAUSED'
  if (stage === 'active') return 'SESSION_ACTIVE'
  if (stage === 'snoozed') return 'SNOOZED'
  if (stage === 'pending') return 'DUE'
  return 'WAITING'
}

export function pauseDeadline(now: number, option: PauseOption): number {
  if (option !== 'tomorrow') return now + option * MINUTE
  const local = new Date(now)
  local.setHours(24, 0, 0, 0)
  return local.getTime()
}

/** Returns the local end of a half-open quiet interval, if it contains now. */
export function quietEnd(now: number, hours: ReminderSettings['quietHours']): number | null {
  if (!hours || hours.start === hours.end) return null
  const local = new Date(now)
  const minute = local.getHours() * 60 + local.getMinutes()
  const crossesMidnight = hours.start > hours.end
  if (
    crossesMidnight
      ? minute < hours.start && minute >= hours.end
      : minute < hours.start || minute >= hours.end
  ) {
    return null
  }
  const days = crossesMidnight && minute >= hours.start ? 1 : 0
  local.setHours(Math.floor(hours.end / 60) + days * 24, hours.end % 60, 0, 0)
  // During a repeated local hour, Date can resolve a wall time to its earlier occurrence.
  return Math.max(local.getTime(), now + (60 - localSeconds(now)) * 1_000)
}

function localSeconds(now: number) {
  const date = new Date(now)
  return date.getSeconds() + date.getMilliseconds() / 1_000
}
