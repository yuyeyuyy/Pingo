import type { ReminderSettings, SchedulerPhase } from '../domain/scheduling'
import type { AnswerInput, AnswerView, SessionTarget } from '../domain/session'

export {
  INTERVAL_PRESETS,
  QUESTION_PRESETS,
  PAUSE_OPTIONS,
  SNOOZE_MINUTES,
} from '../domain/scheduling'
export type { ReminderSettings, PauseOption } from '../domain/scheduling'
export type { AnswerView, AnswerInput, SessionTarget } from '../domain/session'

export interface ReminderStatus {
  phase: SchedulerPhase
  settings: ReminderSettings
  nextAt: number | null
  pauseUntil: number | null
  pendingSessionId: string | null
  notice: 'empty-bank' | null
}

export interface SubmitAnswerRequest extends SessionTarget {
  answer: AnswerInput
}

export const REMINDER_EVENTS = {
  status: 'reminder:status-changed',
  answer: 'learning:view-changed',
} as const

export interface ReminderEvents {
  status: ReminderStatus
  answer: AnswerView
}
