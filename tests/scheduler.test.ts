import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchedulerService } from '../src/application/reminders/scheduler'
import { DEFAULT_REMINDER_SETTINGS, MINUTE } from '../src/domain/scheduling'
import type { AnswerView } from '../src/domain/session'
import { questions, schedulerFixture } from './helpers/reminders'

const time = (minutes: number) => vi.advanceTimersByTime(minutes * MINUTE)
function current(service: SchedulerService): Extract<AnswerView, { kind: 'question' }> {
  const view = service.answerView()
  if (view?.kind !== 'question') throw new Error('Expected an active question')
  return view
}

function answerFirst(service: SchedulerService) {
  const view = current(service)
  const target = { sessionId: view.sessionId, questionId: view.question.id }
  service.submit({ ...target, answer: { kind: 'multiple-choice', optionIndex: 0 } })
  return target
}

describe('reminder scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 18, 10, 0))
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('waits the default 30 minutes and retains one ignored notification', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    expect(service.status()).toMatchObject({ phase: 'WAITING', nextAt: Date.now() + 30 * MINUTE })
    time(29)
    expect(fixture.notify).not.toHaveBeenCalled()
    time(1)
    expect(service.status().phase).toBe('DUE')
    expect(fixture.notify).toHaveBeenCalledTimes(1)
    expect(fixture.show).not.toHaveBeenCalled()
    time(180)
    expect(fixture.source).toHaveBeenCalledTimes(1)
    expect(fixture.notify).toHaveBeenCalledTimes(1)
    expect(service.status().pendingSessionId).toEqual('session-1')
  })

  it('uses a new interval immediately and restarts the countdown when re-enabled', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    time(5)
    service.updateSettings({ ...DEFAULT_REMINDER_SETTINGS, intervalMinutes: 45 })
    expect(service.status().nextAt).toBe(Date.now() + 45 * MINUTE)
    service.updateSettings({ ...service.status().settings, enabled: false })
    time(60)
    expect(fixture.notify).not.toHaveBeenCalled()
    service.updateSettings({ ...service.status().settings, enabled: true })
    time(44)
    expect(fixture.notify).not.toHaveBeenCalled()
    time(1)
    expect(fixture.notify).toHaveBeenCalledOnce()
  })

  it('uses the saved question count for a new session and preserves an active snapshot', () => {
    const fixture = schedulerFixture({
      questions: () => [questions[0]!, questions[0]!, questions[1]!],
    })
    const service = fixture.create()
    service.start()
    service.updateSettings({ ...DEFAULT_REMINDER_SETTINGS, mode: 'popup', questionsPerSession: 5 })
    time(30)
    expect(current(service).total).toBe(2)
    expect(fixture.show).toHaveBeenCalledExactlyOnceWith(false)
    service.updateSettings({ ...service.status().settings, questionsPerSession: 1 })
    expect(current(service).total).toBe(2)
    service.windowClosed()
    time(30)
    expect(current(service).total).toBe(1)
  })

  it('opens a pending session at most once on repeated notification clicks', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    time(30)
    const open = fixture.notify.mock.calls[0]?.[0]
    open?.()
    open?.()
    time(100)
    expect(fixture.source).toHaveBeenCalledExactlyOnceWith(3, { bankId: null, source: 'all' })
    expect(fixture.show).toHaveBeenCalledExactlyOnceWith(true)
    expect(current(service).sessionId).toBe('session-1')
    expect(current(service).question).not.toHaveProperty('correctOptionIndex')
  })

  it('preserves submitted answers and the question index when snoozed', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    service.updateSettings({ ...DEFAULT_REMINDER_SETTINGS, mode: 'popup' })
    service.startLearning()
    const target = answerFirst(service)
    service.advance(target)
    const before = current(service)
    service.snooze(target.sessionId, 10)
    expect(service.status().phase).toBe('SNOOZED')
    expect(fixture.close).toHaveBeenCalledOnce()
    time(9)
    expect(fixture.show).toHaveBeenCalledTimes(1)
    time(1)
    expect(current(service)).toEqual(before)
    expect(fixture.source).toHaveBeenCalledOnce()
    service.windowClosed()
    expect(fixture.history[0]?.session.answers).toHaveLength(1)
  })

  it('keeps quiet while paused and starts a fresh interval on expiry', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    time(29)
    service.pause(30)
    time(29)
    expect(service.status().phase).toBe('PAUSED')
    expect(fixture.notify).not.toHaveBeenCalled()
    time(1)
    expect(service.status()).toMatchObject({ phase: 'WAITING', nextAt: Date.now() + 30 * MINUTE })
    time(30)
    expect(fixture.notify).toHaveBeenCalledOnce()
  })

  it('supports pausing until local midnight and restarting early with manual resume', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    service.pause('tomorrow')
    expect(service.status().pauseUntil).toBe(new Date(2026, 10, 19, 0, 0).getTime())
    time(3)
    service.resume()
    expect(service.status()).toMatchObject({
      phase: 'WAITING',
      pauseUntil: null,
      nextAt: Date.now() + 30 * MINUTE,
    })
  })

  it('does not deliver missed reminders after suspend and wake', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    service.suspend()
    time(180)
    service.wake()
    service.wake()
    expect(fixture.notify).not.toHaveBeenCalled()
    expect(service.status().nextAt).toBe(Date.now() + 30 * MINUTE)
    time(30)
    expect(fixture.notify).toHaveBeenCalledOnce()
  })

  it('restores a future deadline and does not resend an ignored notification on restart', () => {
    const fixture = schedulerFixture()
    let service = fixture.create()
    service.start()
    time(10)
    const nextAt = service.status().nextAt
    service.stop()
    service = fixture.create()
    service.start()
    expect(service.status().nextAt).toBe(nextAt)
    time(20)
    expect(fixture.notify).toHaveBeenCalledOnce()
    service.stop()
    service = fixture.create()
    service.start()
    expect(service.status()).toMatchObject({ phase: 'DUE', pendingSessionId: 'session-1' })
    time(30)
    expect(fixture.notify).toHaveBeenCalledOnce()
    expect(fixture.source).toHaveBeenCalledOnce()
  })

  it('restores interrupted progress and wakes an overdue snooze only once', () => {
    const fixture = schedulerFixture()
    let service = fixture.create()
    service.start()
    const settings = { ...DEFAULT_REMINDER_SETTINGS, mode: 'popup' as const }
    service.updateSettings(settings)
    service.startLearning()
    const target = answerFirst(service)
    service.stop()
    service = fixture.create()
    service.start()
    expect(service.status().pendingSessionId).toBe(target.sessionId)
    service.startLearning()
    expect(current(service).feedback?.outcome).toBe('correct')
    service.snooze(target.sessionId, 5)
    service.stop()
    time(20)
    service = fixture.create()
    service.start()
    time(1)
    expect(current(service).sessionId).toBe(target.sessionId)
    expect(current(service).feedback?.outcome).toBe('correct')
    expect(fixture.source).toHaveBeenCalledOnce()
    expect(fixture.show).toHaveBeenCalledTimes(3)
  })

  it('schedules normally with an empty question bank and avoids an immediate retry', () => {
    const fixture = schedulerFixture({ questions: () => [] })
    const service = fixture.create()
    service.start()
    time(30)
    expect(service.status()).toMatchObject({
      phase: 'WAITING',
      notice: 'empty-bank',
      nextAt: Date.now() + 30 * MINUTE,
    })
    expect(fixture.notify).not.toHaveBeenCalled()
    expect(fixture.show).not.toHaveBeenCalled()
  })

  it('clears the empty-bank notice without moving the next deadline after questions are added', () => {
    const fixture = schedulerFixture({ questions: () => [] })
    const service = fixture.create()
    service.start()
    service.startLearning()
    const nextAt = service.status().nextAt
    expect(service.status().notice).toBe('empty-bank')
    service.questionsAdded()
    expect(service.status()).toMatchObject({ notice: null, nextAt })
    expect(fixture.show).not.toHaveBeenCalled()
  })

  it('defers a cross-midnight quiet period and rechecks the system at its end', () => {
    vi.setSystemTime(new Date(2026, 10, 18, 22, 45))
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    service.updateSettings({ ...DEFAULT_REMINDER_SETTINGS, quietHours: { start: 1380, end: 480 } })
    time(30)
    const end = new Date(2026, 10, 19, 8, 0).getTime()
    expect(service.status().nextAt).toBe(end)
    expect(fixture.notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(end - Date.now())
    expect(fixture.notify).toHaveBeenCalledOnce()
  })

  it('defers when locked or idle and falls back to notifications when fullscreen is unknown', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    service.updateSettings({ ...DEFAULT_REMINDER_SETTINGS, mode: 'popup', avoidFullscreen: true })
    fixture.system.locked = true
    time(30)
    expect(fixture.source).not.toHaveBeenCalled()
    fixture.system.locked = false
    fixture.system.idle = true
    time(30)
    expect(fixture.source).not.toHaveBeenCalled()
    fixture.system.idle = false
    fixture.system.fullscreen = 'unknown'
    time(30)
    expect(fixture.notify).toHaveBeenCalledOnce()
    expect(fixture.show).not.toHaveBeenCalled()
  })

  it('archives only submitted answers on close and starts counting from the time of close', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    service.startLearning()
    answerFirst(service)
    time(40)
    service.windowClosed()
    expect(service.answerView()).toBeNull()
    expect(service.status()).toMatchObject({ phase: 'WAITING', nextAt: Date.now() + 30 * MINUTE })
    expect(fixture.history).toHaveLength(1)
    expect(fixture.history[0]?.outcome).toBe('skipped')
    expect(fixture.history[0]?.session.answers.map((answer) => answer.feedback.outcome)).toEqual([
      'correct',
    ])
  })

  it('ignores stale repeat submissions and starts the next round from completion', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    service.updateSettings({ ...DEFAULT_REMINDER_SETTINGS, questionsPerSession: 1 })
    service.startLearning()
    time(3)
    const target = answerFirst(service)
    service.submit({ ...target, answer: { kind: 'multiple-choice', optionIndex: 1 } })
    service.advance(target)
    service.advance(target)
    expect(service.answerView()).toMatchObject({ kind: 'summary', correct: 1, incorrect: 0 })
    expect(fixture.history).toHaveLength(1)
    expect(service.status().nextAt).toBe(Date.now() + 30 * MINUTE)
  })

  it('rechecks a changed system clock without issuing multiple overdue reminders', () => {
    const fixture = schedulerFixture()
    const service = fixture.create()
    service.start()
    vi.setSystemTime(Date.now() + 12 * 60 * MINUTE)
    time(5)
    expect(fixture.notify).toHaveBeenCalledOnce()
    time(60)
    expect(fixture.notify).toHaveBeenCalledOnce()
  })
})
