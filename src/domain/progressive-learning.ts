import type { Difficulty } from './question'

export type LearningStrategy = 'random' | 'progressive'
export type LearningRole = 'review' | 'current' | 'challenge' | 'early'
export type LearningNotice = 'empty-bank' | 'empty-favorites' | 'empty-study' | 'nothing-due'

export interface LearningStatus {
  level: Difficulty | null
  dueCount: number
}

export interface LearningQuestionPlan {
  bankId: string
  difficulty: Difficulty
  level: Difficulty
  epoch: number
  role: LearningRole
  calibrates: boolean
}

export interface LearningCandidate extends Omit<LearningQuestionPlan, 'calibrates'> {
  id: string
  conceptKey?: string
  materialSeenAt?: number
}

export const REVIEW_DELAYS = [
  10 * 60_000,
  86_400_000,
  3 * 86_400_000,
  7 * 86_400_000,
  14 * 86_400_000,
  30 * 86_400_000,
] as const

export interface ReviewProgress {
  step: number
  dueAt: number
  lastAttemptAt: number
}

export function afterGradedAnswer(
  previous: ReviewProgress | undefined,
  outcome: 'correct' | 'incorrect',
  at: number,
): ReviewProgress {
  if (outcome === 'correct' && previous && at < previous.dueAt) {
    return { ...previous, lastAttemptAt: at }
  }
  const step =
    outcome === 'incorrect' ? 0 : Math.min((previous?.step ?? 0) + 1, REVIEW_DELAYS.length - 1)
  return { step, dueAt: at + REVIEW_DELAYS[step]!, lastAttemptAt: at }
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
export const CHALLENGE_SAMPLES = 6
export const CHALLENGE_CORRECT = 4

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

export function chooseProgressiveRound(
  candidates: readonly LearningCandidate[],
  count: number,
  fillWithChallenges = false,
): LearningCandidate[] {
  const result: LearningCandidate[] = []
  const seen = new Set<string>()
  const queues: Record<LearningRole, LearningCandidate[]> = {
    review: [],
    current: [],
    challenge: [],
    early: [],
  }
  for (const candidate of candidates) queues[candidate.role].push(candidate)

  function take(role: LearningRole, limit: number) {
    let added = 0
    for (const candidate of queues[role]) {
      if (result.length >= count || added >= limit) break
      const key = candidate.conceptKey
        ? `concept:${candidate.conceptKey}`
        : `question:${candidate.id}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(candidate)
      added++
    }
  }

  const backlog = queues.review.length >= count
  take('review', backlog ? Math.ceil(count / 2) : 1)
  take('current', 1)
  if (!fillWithChallenges && !backlog) take('challenge', 1)
  take('review', count)
  take('current', count)
  if (fillWithChallenges) take('challenge', count)
  if (result.length === 0) take('early', 1)
  return result
}

export function chooseStudyRound(candidates: readonly LearningCandidate[], count: number) {
  const ready = candidates.filter(({ role }) => role !== 'early')
  if (!ready.length) return candidates.filter(({ role }) => role === 'early').slice(0, 1)

  const fresh = chooseProgressiveRound(
    ready.filter(({ materialSeenAt }) => materialSeenAt === undefined),
    count,
    true,
  )
  if (fresh.length === count) return fresh

  const older = ready
    .filter(({ materialSeenAt }) => materialSeenAt !== undefined)
    .sort(
      (a, b) =>
        Number(b.role === 'review') - Number(a.role === 'review') ||
        (a.materialSeenAt ?? 0) - (b.materialSeenAt ?? 0),
    )
  return [...fresh, ...older.slice(0, count - fresh.length)]
}
