import type { ReminderSettings, SchedulerPhase } from '../domain/scheduling'
import type { AnswerInput, AnswerView, SessionTarget } from '../domain/session'
import type { LearningNotice, LearningStatus } from '../domain/progressive-learning'

export {
  INTERVAL_PRESETS,
  QUESTION_PRESETS,
  PAUSE_OPTIONS,
  SNOOZE_MINUTES,
} from '../domain/scheduling'
export type { ReminderSettings, PauseOption, SessionMode } from '../domain/scheduling'
export type { AnswerView, AnswerInput, SessionTarget, StudyMaterialTarget } from '../domain/session'
export { DEFAULT_PRACTICE_SETTINGS } from '../domain/review'
export type { PracticeSettings } from '../domain/review'
export type { LearningStrategy } from '../domain/progressive-learning'

export interface ReminderStatus {
  phase: SchedulerPhase
  settings: ReminderSettings
  nextAt: number | null
  pauseUntil: number | null
  pendingSessionId: string | null
  notice: LearningNotice | null
  reviewRevision: number
  learning?: LearningStatus
}

export interface SubmitAnswerRequest extends SessionTarget {
  answer: AnswerInput
}

export interface SetAnswerFavoriteRequest extends SessionTarget {
  favorite: boolean
}

export interface RateAnswerRequest extends SessionTarget {
  correct: boolean
}

export const REMINDER_EVENTS = {
  status: 'reminder:status-changed',
  answer: 'learning:view-changed',
} as const

export interface ReminderEvents {
  status: ReminderStatus
  answer: AnswerView
}
