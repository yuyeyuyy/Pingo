import type { ReminderSettings, SchedulerPhase } from '../domain/scheduling'
import type { AnswerInput, AnswerView, SessionTarget } from '../domain/session'
import type { LearningNotice, LearningStatus } from '../domain/progressive-learning'
import type { PronunciationPreferences } from '../domain/pronunciation'

export {
  INTERVAL_PRESETS,
  QUESTION_PRESETS,
  PAUSE_OPTIONS,
  SNOOZE_MINUTES,
} from '../domain/scheduling'
export type { ReminderSettings, PauseOption, SessionMode } from '../domain/scheduling'
export { pronunciationForView, spokenWord } from '../domain/session'
export type { PronunciationView } from '../domain/session'
export { DEFAULT_PRONUNCIATION_PREFERENCES, PRONUNCIATION_RATE } from '../domain/pronunciation'
export type { PronunciationPreferences } from '../domain/pronunciation'
export type { AnswerView, AnswerInput, SessionTarget, StudyMaterialTarget } from '../domain/session'
export { DEFAULT_PRACTICE_SETTINGS } from '../domain/review'
export type { PracticeSettings } from '../domain/review'
export type { LearningStrategy } from '../domain/progressive-learning'
export { LEARNING_POOLS } from '../domain/progressive-learning'

export interface ReminderStatus {
  phase: SchedulerPhase
  settings: ReminderSettings
  nextAt: number | null
  pauseUntil: number | null
  pendingSessionId: string | null
  notice: LearningNotice | null
  reviewRevision: number
  learning?: LearningStatus
  pronunciation?: PronunciationPreferences
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
