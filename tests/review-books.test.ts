import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQuestionBankService } from '../src/application/question-bank/service'
import type {
  SchedulerDependencies,
  SchedulerService,
} from '../src/application/reminders/scheduler'
import { DEFAULT_REMINDER_SETTINGS } from '../src/domain/scheduling'
import type { AnswerInput } from '../src/domain/session'
import { openDatabase } from '../src/infrastructure/database/open'
import { createQuestionBankRepository } from '../src/infrastructure/database/question-bank-repository'
import {
  createLearningQuestionSource,
  createReminderStore,
} from '../src/infrastructure/database/reminder-store'
import { questions, schedulerFixture } from './helpers/reminders'

let directory: string
let db: ReturnType<typeof openDatabase>
const choice = {
  kind: 'multiple-choice',
  prompt: '哪一个是正确答案？',
  options: ['A', 'B'],
  correctOptionIndex: 0,
}
const right = { kind: 'multiple-choice', optionIndex: 0 } as const
const wrong = { kind: 'multiple-choice', optionIndex: 1 } as const
const unsure = { kind: 'unsure' } as const

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pingo-review-'))
  db = openDatabase(directory)
})

afterEach(() => {
  if (db.isOpen) db.close()
  rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const source = createLearningQuestionSource(db)
  const store = createReminderStore(db)
  const banks = createQuestionBankService(createQuestionBankRepository(db), randomUUID)
  const scheduler = schedulerFixture({
    store,
    questions: source,
    makeId: randomUUID,
    schedule: () => () => {},
  }).create()
  scheduler.start()
  return { banks, scheduler, source, store }
}

function current(scheduler: SchedulerService) {
  const view = scheduler.answerView()
  if (view?.kind !== 'question') throw new Error('Expected an active question')
  return { ...view, target: { sessionId: view.sessionId, questionId: view.question.id } }
}

function play(scheduler: SchedulerService, answer: AnswerInput) {
  scheduler.startLearning()
  const { target } = current(scheduler)
  scheduler.submit({ ...target, answer })
  scheduler.advance(target)
}

it('records wrong and unsure answers once, tracks consecutive success, and retains favorites after graduation', () => {
  let { banks, scheduler } = setup()
  const bank = banks.createBank({ name: '自定义题库' })
  const question = banks.createQuestion({ bankId: bank.id, question: choice })
  const book = () =>
    banks.queryQuestions({ bankId: bank.id, source: 'mistakes', page: 0, query: '' }).items
  scheduler.updateSettings({
    ...DEFAULT_REMINDER_SETTINGS,
    questionsPerSession: 1,
    practice: { bankId: bank.id, source: 'all', wrongEvery: 0 },
  })

  scheduler.startLearning()
  const { target } = current(scheduler)
  scheduler.setFavorite({ ...target, favorite: true })
  scheduler.setFavorite({ ...target, favorite: true })
  expect(current(scheduler).favorite).toBe(true)
  scheduler.submit({ ...target, answer: wrong })
  scheduler.submit({ ...target, answer: right })
  expect(book()).toMatchObject([{ id: question.id, reviewSuccesses: 0 }])
  scheduler.advance(target)
  play(scheduler, right)
  expect(book()).toMatchObject([{ reviewSuccesses: 1 }])
  play(scheduler, unsure)
  expect(book()).toMatchObject([{ reviewSuccesses: 0 }])
  play(scheduler, right)
  scheduler.stop()
  db.close()

  db = openDatabase(directory)
  const restarted = setup()
  ;({ banks, scheduler } = restarted)
  expect(book()).toMatchObject([{ reviewSuccesses: 1 }])
  expect(restarted.store.isFavorite(question.id)).toBe(true)
  play(scheduler, right)
  expect(book()).toEqual([])
  expect(
    banks.queryQuestions({ bankId: bank.id, source: 'favorites', page: 0, query: '' }).items,
  ).toMatchObject([{ id: question.id }])
  expect(banks.listQuestions({ bankId: bank.id })).toHaveLength(1)
})

it('lets ungraded written answers clear the wrong book through two explicit self-ratings', () => {
  const { banks, scheduler } = setup()
  const bank = banks.createBank({ name: '填写题' })
  banks.createQuestion({
    bankId: bank.id,
    question: { kind: 'short-answer', prompt: '解释一下。', referenceAnswer: '参考文本' },
  })
  const book = () =>
    banks.queryQuestions({ bankId: bank.id, source: 'mistakes', page: 0, query: '' }).items
  play(scheduler, unsure)

  for (let round = 0; round < 2; round++) {
    scheduler.startLearning()
    const { target } = current(scheduler)
    scheduler.submit({ ...target, answer: { kind: 'short-answer', text: '我的答案' } })
    expect(book()).toHaveLength(1)
    scheduler.rateAnswer({ ...target, correct: true })
    scheduler.rateAnswer({ ...target, correct: true })
    expect(current(scheduler).feedback?.outcome).toBe('correct')
    scheduler.advance(target)
    if (round === 0) expect(book()).toMatchObject([{ reviewSuccesses: 1 }])
  }
  expect(book()).toEqual([])
})

it('falls back only from mistakes and only within the selected bank', () => {
  const { banks, scheduler, source, store } = setup()
  const a = banks.createBank({ name: 'A' })
  const b = banks.createBank({ name: 'B' })
  const q1 = banks.createQuestion({ bankId: a.id, question: choice })
  const q2 = banks.createQuestion({ bankId: b.id, question: choice })
  scheduler.updateSettings({
    ...DEFAULT_REMINDER_SETTINGS,
    practice: { bankId: a.id, source: 'mistakes', wrongEvery: 0 },
  })
  play(scheduler, wrong)
  expect(source(10, { bankId: a.id, source: 'mistakes' }).map((item) => item.id)).toEqual([q1.id])

  scheduler.updateSettings({
    ...DEFAULT_REMINDER_SETTINGS,
    practice: { bankId: b.id, source: 'mistakes', wrongEvery: 0 },
  })
  scheduler.startLearning()
  expect(current(scheduler).question.id).toBe(q2.id)
  scheduler.windowClosed()
  scheduler.updateSettings({
    ...DEFAULT_REMINDER_SETTINGS,
    practice: { bankId: b.id, source: 'favorites', wrongEvery: 2 },
  })
  store.setFavorite(q1.id, true)
  expect(scheduler.startLearning().notice).toBe('empty-favorites')
  expect(scheduler.answerView()).toBeNull()

  store.setFavorite(q2.id, true)
  scheduler.startLearning()
  expect(current(scheduler)).toMatchObject({ question: { id: q2.id }, favorite: true })
  banks.removeFavorite({ bankId: a.id, questionId: q2.id })
  expect(store.isFavorite(q2.id)).toBe(true)
  banks.removeFavorite({ bankId: b.id, questionId: q2.id })
  expect(store.isFavorite(q2.id)).toBe(false)
  banks.deleteBank({ bankId: a.id })
  expect(source(10, { bankId: null, source: 'mistakes' })).toEqual([])
  expect(source(10, { bankId: null, source: 'favorites' })).toEqual([])
})

it('rolls back the saved answer, wrong book, and review schedule together', () => {
  const { banks, scheduler, store } = setup()
  const bank = banks.createBank({ name: '回滚验证' })
  banks.createQuestion({ bankId: bank.id, question: choice })
  scheduler.startLearning()
  const { target } = current(scheduler)
  db.exec(`CREATE TRIGGER reject_state BEFORE UPDATE ON reminder_state
    BEGIN SELECT RAISE(ABORT, 'state unavailable'); END`)
  expect(() => scheduler.submit({ ...target, answer: wrong })).toThrow('state unavailable')
  expect(store.load()?.session?.answers).toEqual([])
  const progress = db.prepare('SELECT step FROM question_learning WHERE question_id = ?')
  expect(progress.get(target.questionId)).toBeUndefined()
  expect(
    banks.queryQuestions({ bankId: bank.id, source: 'mistakes', page: 0, query: '' }).items,
  ).toEqual([])
  db.exec('DROP TRIGGER reject_state')
  scheduler.submit({ ...target, answer: wrong })
  expect(progress.get(target.questionId)?.step).toBe(0)
  expect(
    banks.queryQuestions({ bankId: bank.id, source: 'mistakes', page: 0, query: '' }).total,
  ).toBe(1)
})

it('uses each Nth completed round for mistakes and preserves the cycle after restart', () => {
  const selection = { bankId: randomUUID(), source: 'all', wrongEvery: 3 } as const
  const source = vi.fn<SchedulerDependencies['questions']>(() => questions.slice(0, 1))
  const fixture = schedulerFixture({ questions: source, schedule: () => () => {} })
  let scheduler = fixture.create()
  scheduler.start()
  scheduler.updateSettings({ ...DEFAULT_REMINDER_SETTINGS, practice: selection })
  play(scheduler, right)
  scheduler.startLearning()
  scheduler.windowClosed()
  scheduler.stop()
  scheduler = fixture.create()
  scheduler.start()
  play(scheduler, right)
  play(scheduler, right)
  play(scheduler, right)
  expect(source.mock.calls.map(([, requested]) => requested)).toEqual(
    ['all', 'all', 'all', 'mistakes', 'all'].map((source) => ({
      bankId: selection.bankId,
      source,
    })),
  )
})

it('does not count a session toward a changed bank or review frequency', () => {
  const source = vi.fn<SchedulerDependencies['questions']>(() => questions.slice(0, 1))
  const scheduler = schedulerFixture({ questions: source, schedule: () => () => {} }).create()
  scheduler.start()
  const firstBank = randomUUID()
  const secondBank = randomUUID()
  scheduler.updateSettings({
    ...DEFAULT_REMINDER_SETTINGS,
    practice: { bankId: firstBank, source: 'all', wrongEvery: 3 },
  })
  play(scheduler, right)
  scheduler.startLearning()
  const { target } = current(scheduler)
  scheduler.updateSettings({
    ...DEFAULT_REMINDER_SETTINGS,
    practice: { bankId: secondBank, source: 'all', wrongEvery: 2 },
  })
  scheduler.submit({ ...target, answer: right })
  scheduler.advance(target)
  play(scheduler, right)
  play(scheduler, right)
  expect(source.mock.calls.map(([, requested]) => requested)).toEqual([
    { bankId: firstBank, source: 'all' },
    { bankId: firstBank, source: 'all' },
    { bankId: secondBank, source: 'all' },
    { bankId: secondBank, source: 'mistakes' },
  ])
})
