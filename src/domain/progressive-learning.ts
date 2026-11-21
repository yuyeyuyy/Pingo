import type { Difficulty } from './question'

export type LearningStrategy = 'random' | 'progressive'

export interface LearningStrategies {
  allBanks: LearningStrategy
  byBank: Readonly<Record<string, LearningStrategy>>
}

export function strategyForBank(strategies: LearningStrategies, bankId: string | null) {
  if (bankId === null) return strategies.allBanks
  return Object.hasOwn(strategies.byBank, bankId) ? strategies.byBank[bankId]! : 'progressive'
}
export type LearningRole = 'review' | 'current' | 'challenge'
export type LearningNotice =
  | 'empty-bank'
  | 'empty-favorites'
  | 'empty-study'
  | 'empty-materials'
  | 'nothing-due'

export interface LearningStatus {
  level: Difficulty | null
  dueCount: number
}

export const LEARNING_POOLS = {
  new: '新题',
  'review-once': '复习一次',
  mistake: '错题',
  recall: '回忆',
} as const
export type LearningPool = keyof typeof LEARNING_POOLS

export interface LearningQuestionPlan {
  bankId: string
  difficulty: Difficulty
  level: Difficulty
  epoch: number
  role: LearningRole
  pool: LearningPool
  calibrates: boolean
}

export interface LearningCandidate extends Omit<LearningQuestionPlan, 'calibrates'> {
  id: string
  conceptKey?: string
  subjectKey?: string
}

export const FIRST_RECALL_STEP = 3

export function poolForStep(step: number): LearningPool {
  switch (step) {
    case 0:
      return 'new'
    case 1:
      return 'review-once'
    case 2:
      return 'mistake'
    default:
      return 'recall'
  }
}

export function afterGradedAnswer(step: number, outcome: 'correct' | 'incorrect', at: number) {
  if (step >= FIRST_RECALL_STEP) return undefined
  if (outcome === 'incorrect') {
    return { step: 2, dueAt: at }
  }
  return { step: step === 1 ? FIRST_RECALL_STEP : 1, dueAt: at }
}

export interface CalibrationSample {
  id: string
  correct: boolean
}

export interface LearningProfile {
  level: Difficulty
  epoch: number
  samples: readonly CalibrationSample[]
}

export const CALIBRATION_SIZE = 10
export const PROMOTE_AT = 8
export const DEMOTE_AT = 5

/** Select the same or closest lower available level, falling back to the lowest level. */
export function availableLevel(
  levels: readonly Difficulty[],
  preferred?: Difficulty,
): Difficulty | undefined {
  return preferred === undefined
    ? levels[0]
    : (levels.filter((level) => level <= preferred).at(-1) ?? levels[0])
}

export function calibrate(
  profile: LearningProfile,
  samples: readonly CalibrationSample[],
  levels: readonly Difficulty[],
): LearningProfile {
  const distinct = new Map(profile.samples.map((sample) => [sample.id, sample]))
  for (const sample of samples) {
    if (!distinct.has(sample.id)) distinct.set(sample.id, sample)
  }
  const recent = [...distinct.values()].slice(-CALIBRATION_SIZE)
  if (recent.length < CALIBRATION_SIZE) return { ...profile, samples: recent }
  const correct = recent.filter((sample) => sample.correct).length
  const next =
    correct >= PROMOTE_AT
      ? levels.find((level) => level > profile.level)
      : correct <= DEMOTE_AT
        ? levels.filter((level) => level < profile.level).at(-1)
        : undefined
  return next === undefined
    ? { ...profile, samples: recent }
    : { level: next, epoch: profile.epoch + 1, samples: [] }
}

const PRACTICE_POOLS = ['new', 'review-once', 'mistake'] as const
type PracticePool = (typeof PRACTICE_POOLS)[number]
const SMALL_ROUND_ROTATION = [
  'new',
  'review-once',
  'mistake',
  'new',
  'review-once',
  'mistake',
  'new',
  'review-once',
  'mistake',
  'new',
] as const
const WEIGHTS = [4, 3, 3] as const

function roundQuotas(count: number, completedRounds: number) {
  const quotas = { new: 0, 'review-once': 0, mistake: 0 }
  if (count < 3) {
    for (let index = 0; index < count; index++) {
      const slot = (completedRounds * count + index) % SMALL_ROUND_ROTATION.length
      quotas[SMALL_ROUND_ROTATION[slot]!]++
    }
    return quotas
  }

  const order =
    completedRounds % 2 === 0 ? PRACTICE_POOLS : (['new', 'mistake', 'review-once'] as const)
  const shares = order.map((pool, index) => {
    const scaled = count * WEIGHTS[index]!
    quotas[pool] = Math.floor(scaled / 10)
    return { pool, remainder: scaled % 10 }
  })
  const unassigned = count - quotas.new - quotas['review-once'] - quotas['mistake']
  for (const { pool } of shares.sort((a, b) => b.remainder - a.remainder).slice(0, unassigned)) {
    quotas[pool]++
  }
  return quotas
}

export function chooseProgressiveRound(
  candidates: readonly LearningCandidate[],
  count: number,
  completedRounds: number,
): LearningCandidate[] {
  const quotas = roundQuotas(count, completedRounds)
  const picked: LearningCandidate[] = []
  const seen = new Set<string>()
  const queues: Record<PracticePool, LearningCandidate[]> = {
    new: [],
    'review-once': [],
    mistake: [],
  }
  for (const candidate of candidates) {
    if (candidate.pool !== 'recall') {
      queues[candidate.pool].push(candidate)
    }
  }

  function take(pool: PracticePool, limit: number) {
    const queue = queues[pool]
    const target = Math.min(count, picked.length + limit)
    while (picked.length < target) {
      const candidate = queue.shift()
      if (!candidate) break
      const key =
        candidate.subjectKey !== undefined
          ? JSON.stringify(['subject', candidate.bankId, candidate.subjectKey])
          : candidate.conceptKey !== undefined
            ? JSON.stringify(['concept', candidate.conceptKey])
            : JSON.stringify(['question', candidate.id])
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(candidate)
    }
  }

  take('review-once', quotas['review-once'])
  take('mistake', quotas['mistake'])
  take('new', count)
  take('review-once', count)
  take('mistake', count)
  return picked
}
