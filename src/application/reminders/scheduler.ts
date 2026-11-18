import {
  DEFAULT_REMINDER_SETTINGS,
  MINUTE,
  pauseDeadline,
  quietEnd,
  schedulerPhase,
} from '../../domain/scheduling'
import type { PauseOption, ReminderSettings } from '../../domain/scheduling'
import { gradeAnswer, questionView, sessionSummary } from '../../domain/session'
import type {
  AnswerView,
  LearningSession,
  SessionQuestion,
  SessionTarget,
} from '../../domain/session'
import type { ReminderStatus, SubmitAnswerRequest } from '../../shared/reminders'
import { invalid } from './validation'

export interface ReminderState {
  settings: ReminderSettings
  pauseUntil: number | null
  nextAt: number | null
  session: LearningSession | null
}

export interface EndedSession {
  session: LearningSession
  at: number
  outcome: 'completed' | 'skipped'
}

export interface ReminderStore {
  load(): ReminderState | undefined
  save(state: ReminderState, ended?: EndedSession): void
}

export interface SchedulerDependencies {
  store: ReminderStore
  questions(count: number): readonly SessionQuestion[]
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
  private summary: Extract<AnswerView, { kind: 'summary' }> | null = null
  private notificationToken: object | null = null

  constructor(private readonly dependencies: SchedulerDependencies) {
    this.state = dependencies.store.load() ?? {
      settings: { ...DEFAULT_REMINDER_SETTINGS },
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
    return {
      settings,
      phase: this.running
        ? schedulerPhase(settings.enabled, pauseUntil, session?.stage)
        : 'STOPPED',
      pauseUntil,
      nextAt: settings.enabled ? nextAt : null,
      pendingSessionId: session?.stage === 'pending' ? session.id : null,
      notice: this.notice,
    }
  }

  answerView(): AnswerView {
    const session = this.state.session
    return session?.stage === 'active' ? questionView(session) : this.summary
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
    this.commit({ ...this.state, settings, nextAt: target })
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
      else this.emptyBank()
    }
    return this.status()
  }

  skipPending(id: string): ReminderStatus {
    if (this.state.session?.id === id && this.state.session.stage === 'pending')
      this.finish('skipped')
    return this.status()
  }

  questionsAdded(): void {
    if (this.notice === 'empty-bank') {
      this.notice = null
      this.publish()
    }
  }

  submit(input: SubmitAnswerRequest): AnswerView {
    const session = this.target(input)
    if (!session || session.answers[session.index]) return this.answerView()
    const question = session.questions[session.index]
    const feedback = question && gradeAnswer(question, input.answer)
    if (!feedback) invalid('请填写有效的答案。')
    const answer = { questionId: input.questionId, feedback, submittedAt: this.dependencies.now() }
    this.commit({ ...this.state, session: { ...session, answers: [...session.answers, answer] } })
    return this.answerView()
  }

  advance(input: SessionTarget): AnswerView {
    const session = this.target(input)
    if (!session || !session.answers[session.index]) return this.answerView()
    if (session.index + 1 === session.questions.length) this.finish('completed')
    else this.commit({ ...this.state, session: { ...session, index: session.index + 1 } })
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
      input.questionId === session.questions[session.index]?.id
      ? session
      : null
  }

  private makeSession(): LearningSession | null {
    const count = this.state.settings.questionsPerSession
    const questions = [
      ...new Map(
        this.dependencies.questions(count).map((question) => [question.id, question]),
      ).values(),
    ].slice(0, count)
    if (!questions.length) return null
    return {
      id: this.dependencies.makeId(),
      startedAt: this.dependencies.now(),
      stage: 'pending',
      questions,
      index: 0,
      answers: [],
    }
  }

  private emptyBank(): void {
    this.notice = 'empty-bank'
    this.commit({ ...this.state, nextAt: this.nextRegular() })
  }

  private finish(outcome: EndedSession['outcome']): void {
    const session = this.state.session
    if (!session) return
    const at = this.dependencies.now()
    const summary = outcome === 'completed' ? sessionSummary(session) : null
    const ended = session.answers.length > 0 ? { session, at, outcome } : undefined
    this.commit({ ...this.state, session: null, nextAt: this.nextRegular(at) }, ended, summary)
    this.dismiss()
  }

  private nextRegular(now = this.dependencies.now()): number | null {
    return this.state.settings.enabled && this.state.pauseUntil === null
      ? this.afterInterval(now)
      : null
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

  private commit(next: ReminderState, ended?: EndedSession, summary = this.summary): void {
    this.dependencies.store.save(next, ended)
    this.state = next
    this.summary = summary
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
    if (!next) {
      this.emptyBank()
      return
    }
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
      undefined,
      null,
    )
    this.dismiss()
    this.present(focus)
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
