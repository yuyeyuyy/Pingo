import type { LearningNotice, LearningStatus } from '../../domain/progressive-learning'
import type { PracticeSettings } from '../../domain/review'
import type { SessionQuestion } from '../../domain/session'

export type LearningSelection = Pick<PracticeSettings, 'bankId' | 'source'> & {
  requiresMaterial?: boolean
}

export interface LearningEngine {
  pick(
    count: number,
    selection: LearningSelection,
    now: number,
    completedRounds?: number,
  ): { questions: readonly SessionQuestion[]; notice: LearningNotice | null }
  status(selection: LearningSelection, now: number): LearningStatus
}
