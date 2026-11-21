import { vi } from 'vitest'
import { SchedulerService } from '../../src/application/reminders/scheduler'
import type {
  EndedSession,
  ReminderState,
  SchedulerDependencies,
} from '../../src/application/reminders/scheduler'
import type { SessionQuestion } from '../../src/domain/session'
import type { LearningStrategy } from '../../src/domain/progressive-learning'

export const questions: SessionQuestion[] = [
  {
    id: 'q1',
    bankName: '科学',
    kind: 'multiple-choice',
    prompt: '水的冰点？',
    options: ['0°C', '10°C'],
    correctOptionIndex: 0,
  },
  {
    id: 'q2',
    bankName: '科学',
    kind: 'short-answer',
    prompt: '解释蒸发。',
    referenceAnswer: '液体变为气体。',
  },
  { id: 'q3', bankName: '科学', kind: 'short-answer', prompt: '解释凝固。' },
]

export function schedulerFixture(overrides: Partial<SchedulerDependencies> = {}) {
  let state: ReminderState | undefined
  const history: EndedSession[] = []
  const favorites = new Set<string>()
  const correctlyAnswered = new Set<string>()
  const bankStrategies = new Map<string, LearningStrategy>()
  let ids = 0
  const system: ReturnType<SchedulerDependencies['system']> = {
    idle: false,
    locked: false,
    fullscreen: false,
  }
  const source = vi.fn((count: number) => questions.slice(0, count))
  const notify = vi.fn<(open: () => void) => void>()
  const show = vi.fn<(focus: boolean) => void>()
  const close = vi.fn<() => void>()
  const dependencies: SchedulerDependencies = {
    store: {
      load: () => state && structuredClone(state),
      save(next, { ended, review, bankStrategy } = {}) {
        state = structuredClone(next)
        if (bankStrategy) bankStrategies.set(bankStrategy.bankId, bankStrategy.strategy)
        if (ended) history.push(structuredClone(ended))
        if (review?.outcome === 'correct') correctlyAnswered.add(review.questionId)
      },
      bankStrategies: () => Object.fromEntries(bankStrategies),
      correctlyAnsweredQuestionIds: (ids) => new Set(ids.filter((id) => correctlyAnswered.has(id))),
      isFavorite: (id) => favorites.has(id),
      setFavorite(id, favorite) {
        if (favorite) favorites.add(id)
        else favorites.delete(id)
        return true
      },
    },
    questions: source,
    now: Date.now,
    makeId: () => `session-${++ids}`,
    schedule(delay, callback) {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
    system: () => system,
    notify,
    dismissNotification: () => {},
    showAnswer: show,
    closeAnswer: close,
    publish: () => {},
    reportError: (error) => {
      throw error
    },
    ...overrides,
  }
  return {
    dependencies,
    source,
    notify,
    show,
    close,
    history,
    system,
    create: () => new SchedulerService(dependencies),
  }
}
