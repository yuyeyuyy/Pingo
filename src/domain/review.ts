export const PRACTICE_SOURCES = {
  all: '完整题库',
  mistakes: '错题本',
  favorites: '收藏本',
} as const

export type PracticeSource = keyof typeof PRACTICE_SOURCES

export interface PracticeSettings {
  readonly bankId: string | null
  readonly source: PracticeSource
  readonly wrongEvery: number
}

export const DEFAULT_PRACTICE_SETTINGS: Readonly<PracticeSettings> = {
  bankId: null,
  source: 'all',
  wrongEvery: 0,
}

export const REVIEW_SUCCESSES = 2
export type ReviewOutcome = 'correct' | 'incorrect' | 'ungraded'

export interface ReviewAttempt {
  readonly questionId: string
  readonly outcome: ReviewOutcome
  readonly at: number
}

export function samePractice(left: PracticeSettings, right: PracticeSettings): boolean {
  return (
    left.bankId === right.bankId &&
    left.source === right.source &&
    left.wrongEvery === right.wrongEvery
  )
}

export function nextPracticeSource(
  settings: PracticeSettings,
  completedInCycle: number,
): PracticeSource {
  if (
    settings.source === 'all' &&
    settings.wrongEvery > 0 &&
    completedInCycle + 1 >= settings.wrongEvery
  ) {
    return 'mistakes'
  }
  return settings.source
}
