import {
  DEFAULT_REMINDER_SETTINGS,
  MINUTE,
  pauseDeadline,
  quietEnd,
  schedulerPhase,
} from '../../domain/scheduling'
import type { PauseOption, ReminderSettings } from '../../domain/scheduling'
import { DEFAULT_PRACTICE_SETTINGS, nextPracticeSource, samePractice } from '../../domain/review'
import type { PracticeSettings, ReviewAttempt } from '../../domain/review'
import {
  gradeAnswer,
  nextStudyMaterial,
  prepareSessionQuestion,
  questionView,
  sessionSummary,
} from '../../domain/session'
import type { StudySubject } from '../../domain/study-material'
import type { PronunciationPreferences } from '../../domain/pronunciation'
import type {
  AnswerView,
  LearningSession,
  SessionQuestion,
  SessionStudyMaterial,
  SessionTarget,
  StudyMaterialTarget,
} from '../../domain/session'
import type {
  RateAnswerRequest,
  ReminderStatus,
  SetAnswerFavoriteRequest,
  SubmitAnswerRequest,
} from '../../shared/reminders'
import { RequestError } from '../request-error'
import type { LearningEngine, LearningSelection } from './learning-engine'
import { invalid } from './validation'

export interface ReminderState {
  settings: ReminderSettings
  pauseUntil: number | null
  nextAt: number | null
  session: LearningSession | null
  completedInCycle?: number
  completedRounds?: number
  pronunciation?: PronunciationPreferences
}

export interface EndedSession {
  session: LearningSession
  at: number
  outcome: 'completed' | 'skipped'
}

export interface ReminderEffects {
  ended?: EndedSession
  review?: ReviewAttempt
  studySeen?: StudySubject & { at: number }
}

export interface ReminderStore {
  load(): ReminderState | undefined
  save(state: ReminderState, effects?: ReminderEffects): void
  correctlyAnsweredQuestionIds(questionIds: readonly string[]): ReadonlySet<string>
  isFavorite(questionId: string): boolean
  setFavorite(questionId: string, favorite: boolean): boolean
}

export interface SchedulerDependencies {
  store: ReminderStore
  learning?: LearningEngine
  /** Returns the linked materials in the same order as the question IDs. */
  studyMaterials?(questionIds: readonly string[]): readonly SessionStudyMaterial[]
  questions(count: number, selection: LearningSelection): readonly SessionQuestion[]
  makeId(): string
  now(): number
  schedule(delay: number, callback: () => void): () => void
  system(): { idle: boolean | 'unknown'; locked: boolean; fullscreen: boolean | 'unknown' }
  notify(open: () => void): void
  dismissNotification(): void
  showAnswer(focus: boolean): void
  closeAnswer(): void
  publish(status: ReminderStatus, answer: AnswerView): void
  reportError(error: unknown): void
}

const CLOCK_CHECK = 5 * MINUTE

export class SchedulerService {
  private state: ReminderState
  private running = false
  private sleeping = false
  private cancelTimer?: () => void
  private notice: ReminderStatus['notice'] = null
  private reviewRevision = 0
  private summary: Extract<AnswerView, { kind: 'summary' }> | null = null
  private notificationToken: object | null = null

  constructor(private readonly dependencies: SchedulerDependencies) {
    this.state = dependencies.store.load() ?? {
      settings: {
        ...DEFAULT_REMINDER_SETTINGS,
        ...(dependencies.learning ? { strategy: 'progressive' } : {}),
      },
      pauseUntil: null,
      nextAt: null,
      session: null,
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.sleeping = false
    const now = this.dependencies.now()
    const state = this.state
    const session =
      state.session?.stage === 'active'
        ? { ...state.session, stage: 'pending' as const }
        : state.session
    const pauseUntil = state.pauseUntil !== null && state.pauseUntil > now ? state.pauseUntil : null
    let nextAt = state.nextAt

    if (!state.settings.enabled || pauseUntil !== null || session?.stage === 'pending')
      nextAt = null
    else if (session?.stage === 'snoozed')
      nextAt = state.pauseUntil !== null ? this.afterInterval(now) : Math.max(nextAt ?? now, now)
    else if (nextAt === null || nextAt <= now || state.pauseUntil !== null)
      nextAt = this.afterInterval(now)

    this.commit({ ...state, session, pauseUntil, nextAt })
  }

  stop(): void {
    this.running = false
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.dismiss()
  }

  status(): ReminderStatus {
    const { settings, pauseUntil, session, nextAt } = this.state
    const learning =
      settings.strategy === 'progressive'
        ? this.dependencies.learning?.status(this.selection(), this.dependencies.now())
        : undefined
    return {
      settings,
      phase: this.running
        ? schedulerPhase(settings.enabled, pauseUntil, session?.stage)
        : 'STOPPED',
      pauseUntil,
      nextAt: settings.enabled ? nextAt : null,
      pendingSessionId: session?.stage === 'pending' ? session.id : null,
      notice: this.notice,
      reviewRevision: this.reviewRevision,
      ...(this.state.pronunciation ? { pronunciation: this.state.pronunciation } : {}),
      ...(learning ? { learning } : {}),
    }
  }

  answerView(): AnswerView {
    const session = this.state.session
    if (session?.stage !== 'active') return this.summary
    const question = session.questions[session.index]
    const view =
      nextStudyMaterial(session) ??
      questionView(session, !!question && this.dependencies.store.isFavorite(question.id))
    return view && this.state.pronunciation
      ? { ...view, pronunciationPreferences: this.state.pronunciation }
      : view
  }

  updatePronunciation(pronunciation: PronunciationPreferences): ReminderStatus {
    this.commit({ ...this.state, pronunciation })
    return this.status()
  }

  updateSettings(settings: ReminderSettings): ReminderStatus {
    const { enabled, intervalMinutes } = this.state.settings
    const { session, pauseUntil, nextAt } = this.state
    const shouldWait =
      settings.enabled && pauseUntil === null && (!session || session.stage === 'snoozed')
    let target = shouldWait ? nextAt : null
    if (
      shouldWait &&
      (!enabled || (!session && intervalMinutes !== settings.intervalMinutes) || target === null)
    ) {
      target = this.dependencies.now() + settings.intervalMinutes * MINUTE
    }
    const practice = settings.practice ?? this.state.settings.practice
    const strategy = settings.strategy ?? this.state.settings.strategy
    const sessionMode = settings.sessionMode ?? this.state.settings.sessionMode
    const practiceChanged = !samePractice(practice ?? DEFAULT_PRACTICE_SETTINGS, this.practice())
    if (
      practiceChanged ||
      strategy !== this.state.settings.strategy ||
      sessionMode !== this.state.settings.sessionMode
    )
      this.notice = null
    this.commit({
      ...this.state,
      settings: {
        ...settings,
        ...(practice ? { practice } : {}),
        ...(strategy ? { strategy } : {}),
        ...(sessionMode ? { sessionMode } : {}),
      },
      nextAt: target,
      completedInCycle: practiceChanged ? 0 : this.state.completedInCycle,
    })
    if (!settings.enabled) this.dismiss()
    return this.status()
  }

  pause(option: PauseOption): ReminderStatus {
    const now = this.dependencies.now()
    this.commit({ ...this.state, pauseUntil: pauseDeadline(now, option), nextAt: null })
    this.dismiss()
    return this.status()
  }

  resume(): ReminderStatus {
    const { settings, session } = this.state
    const canSchedule = settings.enabled && (!session || session.stage === 'snoozed')
    this.commit({
      ...this.state,
      pauseUntil: null,
      nextAt: canSchedule ? this.afterInterval(this.dependencies.now()) : null,
    })
    return this.status()
  }

  suspend(): void {
    this.sleeping = true
    this.arm()
  }

  wake(): void {
    this.sleeping = false
    this.recheckOnWake()
  }

  private recheckOnWake(): void {
    if (!this.running) return
    const now = this.dependencies.now()
    const { settings, pauseUntil, nextAt, session } = this.state
    if (pauseUntil !== null && pauseUntil <= now) {
      this.resume()
    } else if (settings.enabled && !session && nextAt !== null && nextAt <= now) {
      this.commit({ ...this.state, nextAt: this.afterInterval(now) })
    } else {
      this.arm()
    }
  }

  startLearning(): ReminderStatus {
    const current = this.state.session
    if (current?.stage === 'active') {
      this.present(true)
    } else {
      const session = current ?? this.makeSession()
      if (session) this.open(session, true)
    }
    return this.status()
  }

  skipPending(id: string): ReminderStatus {
    if (this.state.session?.id === id && this.state.session.stage === 'pending')
      this.finish('skipped')
    return this.status()
  }

  questionsAdded(): void {
    if (
      this.notice === 'empty-bank' ||
      this.notice === 'empty-study' ||
      this.notice === 'nothing-due'
    )
      this.notice = null
    this.publish()
  }

  reviewsChanged(): void {
    this.reviewRevision++
    this.publish()
  }

  setFavorite(input: SetAnswerFavoriteRequest): AnswerView {
    if (!this.target(input)) return this.answerView()
    if (!this.dependencies.store.setFavorite(input.questionId, input.favorite)) {
      throw new RequestError('NOT_FOUND', '该题已经从题库删除。')
    }
    this.reviewsChanged()
    return this.answerView()
  }

  submit(input: SubmitAnswerRequest): AnswerView {
    const session = this.target(input)
    if (!session || session.answers[session.index]) return this.answerView()
    const question = session.questions[session.index]
    const feedback = question && gradeAnswer(question, input.answer)
    if (!feedback) invalid('请填写有效的答案。')
    const answer = { questionId: input.questionId, feedback, submittedAt: this.dependencies.now() }
    this.commit(
      { ...this.state, session: { ...session, answers: [...session.answers, answer] } },
      {
        review: { questionId: input.questionId, outcome: feedback.outcome, at: answer.submittedAt },
      },
    )
    return this.answerView()
  }

  rateAnswer(input: RateAnswerRequest): AnswerView {
    const session = this.target(input)
    if (!session) return this.answerView()
    const submitted = session.answers[session.index]
    const feedback = submitted?.feedback
    if (!submitted || feedback?.kind !== 'short-answer' || feedback.outcome !== 'ungraded')
      return this.answerView()
    const outcome: 'correct' | 'incorrect' = input.correct ? 'correct' : 'incorrect'
    const answers = [...session.answers]
    answers[session.index] = { ...submitted, feedback: { ...feedback, outcome } }
    this.commit(
      { ...this.state, session: { ...session, answers } },
      { review: { questionId: input.questionId, outcome, at: this.dependencies.now() } },
    )
    return this.answerView()
  }

  advance(input: SessionTarget): AnswerView {
    const session = this.target(input)
    if (!session || !session.answers[session.index]) return this.answerView()
    if (session.index + 1 === session.questions.length) this.finish('completed')
    else this.commit({ ...this.state, session: { ...session, index: session.index + 1 } })
    return this.answerView()
  }

  advanceStudyMaterial(input: StudyMaterialTarget): AnswerView {
    const session = this.state.session
    if (session?.stage !== 'active' || session.id !== input.sessionId || !session.study)
      return this.answerView()
    const material = nextStudyMaterial(session)
    if (material?.position === input.position) {
      const next = { ...session, study: { ...session.study, index: input.position } }
      this.commit(
        {
          ...this.state,
          session: next,
        },
        { studySeen: this.studyExposure(next) },
      )
    }
    return this.answerView()
  }

  snooze(id: string, minutes: number): void {
    const { session, settings, pauseUntil } = this.state
    if (session?.id !== id || session.stage !== 'active') return
    const nextAt =
      settings.enabled && pauseUntil === null ? this.dependencies.now() + minutes * MINUTE : null
    this.commit({ ...this.state, session: { ...session, stage: 'snoozed' }, nextAt })
    this.dismiss()
    this.dependencies.closeAnswer()
  }

  windowClosed(): void {
    if (this.state.session?.stage === 'active') this.finish('skipped')
    else {
      this.summary = null
      this.publish()
    }
  }

  windowUnavailable(): void {
    const session = this.state.session
    if (session?.stage === 'active') {
      this.commit({ ...this.state, session: { ...session, stage: 'pending' }, nextAt: null })
    }
  }

  private target(input: SessionTarget): LearningSession | null {
    const session = this.state.session
    return session?.stage === 'active' &&
      input.sessionId === session.id &&
      !nextStudyMaterial(session) &&
      input.questionId === session.questions[session.index]?.id
      ? session
      : null
  }

  private makeSession(): LearningSession | null {
    const { questionsPerSession: count, strategy = 'random' } = this.state.settings
    const practice = this.practice()
    const selection = this.selection()
    const now = this.dependencies.now()
    const planned =
      strategy === 'progressive'
        ? this.dependencies.learning?.pick(count, selection, now, this.state.completedRounds)
        : undefined
    const available = planned?.questions ?? this.sampleRandom(count, selection)
    const questions = [
      ...new Map(available.map((question) => [question.id, question])).values(),
    ].slice(0, count)
    let study: LearningSession['study']
    let missingMaterials = false
    if (selection.requiresMaterial && questions.length) {
      const correctlyAnswered = this.dependencies.store.correctlyAnsweredQuestionIds(
        questions.map(({ id }) => id),
      )
      const materialIds = questions
        .filter(
          ({ id, learning }) =>
            learning?.pool === 'mistake' ||
            ((!learning?.pool || learning.pool === 'new') && !correctlyAnswered.has(id)),
        )
        .map(({ id }) => id)
      const materials = materialIds.length
        ? (this.dependencies.studyMaterials?.(materialIds) ?? [])
        : []
      missingMaterials = materials.length !== materialIds.length
      study = { materials, index: 0 }
    }
    if (!questions.length || missingMaterials) {
      this.notice =
        planned?.notice ??
        (selection.requiresMaterial
          ? 'empty-study'
          : selection.source === 'favorites'
            ? 'empty-favorites'
            : 'empty-bank')
      this.commit({ ...this.state, nextAt: this.nextRegular(now) })
      return null
    }
    return {
      id: this.dependencies.makeId(),
      startedAt: now,
      stage: 'pending',
      questions: questions.map((question) => prepareSessionQuestion(question, Math.random)),
      index: 0,
      answers: [],
      practice,
      strategy,
      ...(study ? { study } : {}),
    }
  }

  private sampleRandom(count: number, selection: LearningSelection): readonly SessionQuestion[] {
    const questions = this.dependencies.questions(count, selection)
    return questions.length === 0 && selection.source === 'mistakes'
      ? this.dependencies.questions(count, { ...selection, source: 'all' })
      : questions
  }

  private finish(outcome: EndedSession['outcome']): void {
    const session = this.state.session
    if (!session) return
    const at = this.dependencies.now()
    const summary = outcome === 'completed' ? sessionSummary(session) : null
    const ended = session.answers.length > 0 ? { session, at, outcome } : undefined
    const practice = this.practice()
    const completedInCycle =
      outcome === 'completed' &&
      session.practice &&
      samePractice(session.practice, practice) &&
      practice.source === 'all' &&
      practice.wrongEvery > 0
        ? ((this.state.completedInCycle ?? 0) + 1) % practice.wrongEvery
        : this.state.completedInCycle
    this.commit(
      {
        ...this.state,
        session: null,
        nextAt: this.nextRegular(at),
        completedInCycle,
        completedRounds:
          outcome === 'completed'
            ? (this.state.completedRounds ?? 0) + 1
            : this.state.completedRounds,
      },
      { ended, summary },
    )
    this.dismiss()
  }

  private nextRegular(now = this.dependencies.now()): number | null {
    return this.state.settings.enabled && this.state.pauseUntil === null
      ? this.afterInterval(now)
      : null
  }

  private practice(): PracticeSettings {
    return this.state.settings.practice ?? DEFAULT_PRACTICE_SETTINGS
  }

  private selection(): LearningSelection {
    const practice = this.practice()
    return {
      bankId: practice.bankId,
      source: nextPracticeSource(practice, this.state.completedInCycle ?? 0),
      ...(this.state.settings.sessionMode === 'study' ? { requiresMaterial: true } : {}),
    }
  }

  private afterInterval(now: number): number {
    return now + this.state.settings.intervalMinutes * MINUTE
  }

  private publish(): void {
    try {
      this.dependencies.publish(this.status(), this.answerView())
    } catch (error) {
      this.dependencies.reportError(error)
    }
  }

  private commit(
    next: ReminderState,
    effects: ReminderEffects & {
      summary?: Extract<AnswerView, { kind: 'summary' }> | null
    } = {},
  ): void {
    const { summary = this.summary, ...writes } = effects
    this.dependencies.store.save(next, writes)
    this.state = next
    this.summary = summary
    if (writes.review && writes.review.outcome !== 'ungraded') this.reviewRevision++
    this.arm()
    this.publish()
  }

  private arm(minimum = 0): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    if (!this.running || this.sleeping) return
    const { settings, pauseUntil, nextAt } = this.state
    const deadline = pauseUntil ?? (settings.enabled ? nextAt : null)
    if (deadline === null) return
    const delay = Math.max(minimum, Math.min(deadline - this.dependencies.now(), CLOCK_CHECK))
    this.cancelTimer = this.dependencies.schedule(delay, () => {
      this.cancelTimer = undefined
      try {
        this.tick()
      } catch (error) {
        this.dependencies.reportError(error)
        this.arm(MINUTE)
      }
    })
  }

  private tick(): void {
    if (!this.running || this.sleeping) return
    const { settings, pauseUntil, nextAt, session } = this.state
    const now = this.dependencies.now()
    if (pauseUntil !== null && pauseUntil <= now) {
      this.resume()
      return
    }
    if (nextAt === null || nextAt > now || pauseUntil !== null || !settings.enabled) {
      this.arm()
      return
    }
    if (session && session.stage !== 'snoozed') return

    const system = this.dependencies.system()
    const quietUntil = quietEnd(now, settings.quietHours)
    if (quietUntil !== null || (settings.avoidIdle && (system.idle === true || system.locked))) {
      this.commit({ ...this.state, nextAt: quietUntil ?? this.afterInterval(now) })
      return
    }

    const next = session ?? this.makeSession()
    if (!next) return
    const popup =
      settings.mode === 'popup' &&
      (!settings.avoidFullscreen || system.fullscreen === false) &&
      (!settings.avoidIdle || system.idle !== 'unknown')
    if (popup) this.open(next, settings.focusPopup)
    else this.offer(next)
  }

  private open(session: LearningSession, focus: boolean): void {
    this.notice = null
    this.commit(
      { ...this.state, session: { ...session, stage: 'active' }, nextAt: null },
      { summary: null, studySeen: this.studyExposure(session) },
    )
    this.dismiss()
    this.present(focus)
  }

  private studyExposure(session: LearningSession): ReminderEffects['studySeen'] {
    const material = nextStudyMaterial(session)
    if (!material) return undefined
    if (material.material.subject)
      return { ...material.material.subject, at: this.dependencies.now() }
    // Sessions saved before subject tracking can still resume with their original cards.
    const previous = this.dependencies.studyMaterials?.(session.questions.map(({ id }) => id))[
      material.position - 1
    ]
    if (
      previous?.key === material.material.key &&
      previous.bankName === material.material.bankName &&
      previous.subject
    )
      return { ...previous.subject, at: this.dependencies.now() }
    return undefined
  }

  private present(focus: boolean): void {
    try {
      this.dependencies.showAnswer(focus)
    } catch (error) {
      this.dependencies.reportError(error)
      this.windowUnavailable()
    }
  }

  private offer(session: LearningSession): void {
    this.notice = null
    this.commit({ ...this.state, session: { ...session, stage: 'pending' }, nextAt: null })
    this.dismiss()
    const token = {}
    this.notificationToken = token
    this.dependencies.notify(() => {
      if (
        this.notificationToken !== token ||
        this.state.session?.id !== session.id ||
        this.state.session.stage !== 'pending' ||
        this.status().phase !== 'DUE'
      )
        return
      this.open(this.state.session, true)
    })
  }

  private dismiss(): void {
    this.notificationToken = null
    this.dependencies.dismissNotification()
  }
}
