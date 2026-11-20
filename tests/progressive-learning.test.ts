import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQuestionBankService } from '../src/application/question-bank/service'
import { parseQuestionsImport } from '../src/application/question-bank/validation'
import type { SchedulerService } from '../src/application/reminders/scheduler'
import type { Difficulty } from '../src/domain/question'
import { MINUTE } from '../src/domain/scheduling'
import type { AnswerInput } from '../src/domain/session'
import { openDatabase } from '../src/infrastructure/database/open'
import {
  createLearningEngine,
  createLearningProgressWriter,
} from '../src/infrastructure/database/progressive-learning'
import { createQuestionBankRepository } from '../src/infrastructure/database/question-bank-repository'
import {
  createLearningQuestionSource,
  createReminderStore,
} from '../src/infrastructure/database/reminder-store'
import { conversionPrompt } from '../src/shared/question-import-prompt'
import { schedulerFixture } from './helpers/reminders'

const DAY = 24 * 60 * MINUTE
let directory: string
let db: ReturnType<typeof openDatabase>
let now: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pingo-learning-'))
  db = openDatabase(directory)
  now = Date.UTC(2026, 10, 19, 4)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function banks() {
  return createQuestionBankService(createQuestionBankRepository(db), randomUUID)
}

function addQuestions(bankId: string, count: number, difficulty: Difficulty) {
  return Array.from({ length: count }, (_, index) =>
    banks().createQuestion({
      bankId,
      question: {
        kind: 'short-answer',
        prompt: `${difficulty} 档题目 ${index + 1}`,
        acceptedAnswers: ['ok'],
        difficulty,
      },
    }),
  )
}

function scheduler() {
  const fixture = schedulerFixture({
    store: createReminderStore(db),
    questions: createLearningQuestionSource(db),
    learning: createLearningEngine(db),
    makeId: randomUUID,
    now: () => now,
  })
  return { fixture, service: fixture.create() }
}

function study(service: SchedulerService, answer: AnswerInput) {
  const view = service.answerView()
  if (view?.kind !== 'question') throw new Error('Expected a question')
  const target = { sessionId: view.sessionId, questionId: view.question.id }
  service.submit({ ...target, answer })
  service.advance(target)
  return view.question.id
}

function progress(id: string) {
  return db
    .prepare('SELECT step, due_at, last_attempt_at FROM question_learning WHERE question_id = ?')
    .get(id)
}

it('normalizes import metadata and keeps the original question when an import has an invalid level', () => {
  const service = banks()
  const { id } = service.createBank({ name: '水果', template: 'language' })
  const apple = {
    kind: 'multiple-choice',
    languageType: 'word-to-meaning',
    prompt: 'apple 的中文是什么？',
    options: ['苹果', '梨'],
    correctOptionIndex: 0,
    difficulty: 1,
    conceptKey: ' Ａpple:N:Fruit ',
  }
  const append = (questions: unknown[]) =>
    service.appendQuestionImport({ bankId: id, json: JSON.stringify({ questions }) })
  expect(
    append([apple, { ...apple, prompt: '旧格式', difficulty: undefined, conceptKey: undefined }]),
  ).toEqual({ added: 2 })
  const [stored, legacy] = service.listQuestions({ bankId: id })
  expect(stored).toMatchObject({ difficulty: 1, conceptKey: 'apple:n:fruit' })
  expect(legacy).not.toHaveProperty('difficulty')
  const learning = createLearningEngine(db)
  expect(learning.status({ bankId: id, source: 'all' }, now).level).toBe(1)
  for (const invalid of [0, 6, 2.5, '3', null]) {
    expect(() => append([apple, { ...apple, difficulty: invalid }])).toThrow('难度')
  }
  expect(() => append([{ ...apple, conceptKey: '   ' }])).toThrow('知识点')
  expect(service.listQuestions({ bankId: id })).toHaveLength(2)
  expect(
    service.updateQuestion({
      bankId: id,
      questionId: stored!.id,
      question: { ...apple, difficulty: 4, conceptKey: undefined },
    }),
  ).toMatchObject({ difficulty: 4 })
  expect(service.listQuestions({ bankId: id })[0]).not.toHaveProperty('conceptKey')
})

it('grades different words and adds one level for spelling the same word', () => {
  for (const template of ['language', 'basic'] as const) {
    const prompt = conversionPrompt(template)
    expect(prompt).toContain('只有单词和释义时也直接估级')
    expect(prompt).toContain('选择题沿用目标词的单词档位，独立拼写在该词档位上加 1')
    expect(prompt).toContain('跨分片核对同一个词的拼写题难度比选择题高 1 级')
  }
  const json = readFileSync(new URL('../docs/example-language-bank.json', import.meta.url), 'utf8')
  const questions = parseQuestionsImport(json, 'language')
  const gradesFor = (conceptKey: string) =>
    questions
      .filter((question) => question.conceptKey === conceptKey)
      .map((question) => [question.kind, question.difficulty])
  expect(gradesFor('apple:n:fruit')).toEqual([
    ['multiple-choice', 1],
    ['short-answer', 2],
  ])
  expect(gradesFor('mitigate:v:reduce-severity')).toEqual([
    ['multiple-choice', 4],
    ['short-answer', 5],
  ])
})

it('uses review, current and challenge roles with different concepts and reserves space for overdue reviews', () => {
  const service = banks()
  const { id } = service.createBank({ name: '词汇', template: 'basic' })
  const add = (prompt: string, difficulty: Difficulty, conceptKey: string) =>
    service.createQuestion({
      bankId: id,
      question: { kind: 'short-answer', prompt, acceptedAnswers: ['ok'], difficulty, conceptKey },
    })
  const review = add('apple 复习', 1, 'apple')
  add('apple 变体', 1, 'apple')
  const current = add('pear 练习', 1, 'pear')
  add('pear 变体', 2, 'pear')
  const challenge = add('grape 挑战', 2, 'grape')
  const progressWriter = createLearningProgressWriter(db)
  progressWriter.recordAttempt({
    questionId: review.id,
    outcome: 'incorrect',
    at: now - 10 * MINUTE,
  })
  const engine = createLearningEngine(db)
  const scope = { bankId: id, source: 'all' } as const
  expect(engine.pick(3, scope, now, false).questions.map((q) => q.id)).toEqual([
    review.id,
    current.id,
  ])
  db.prepare('INSERT INTO bank_learning_profiles VALUES (?, 1, 0, ?)').run(
    id,
    JSON.stringify(
      Array.from({ length: 6 }, (_, index) => ({ id: String(index), correct: index < 4 })),
    ),
  )
  const mix = engine.pick(3, scope, now, false).questions
  expect(mix.map((q) => [q.id, q.learning?.role])).toEqual([
    [review.id, 'review'],
    [current.id, 'current'],
    [challenge.id, 'challenge'],
  ])
  for (const [concept, offset] of [
    ['banana', 2],
    ['orange', 1],
  ] as const) {
    const item = add(concept, 1, concept)
    progressWriter.recordAttempt({
      questionId: item.id,
      outcome: 'incorrect',
      at: now - (10 + offset) * MINUTE,
    })
  }
  expect(engine.pick(3, scope, now, false).questions.map((q) => q.learning?.role)).toEqual([
    'review',
    'review',
    'current',
  ])
})

it('persists promotion and demotion per bank and only calibrates current-level new questions', () => {
  const bank = banks().createBank({ name: '主库' })
  const other = banks().createBank({ name: '独立库' })
  addQuestions(bank.id, 10, 1)
  addQuestions(bank.id, 10, 2)
  addQuestions(bank.id, 3, 3)
  addQuestions(other.id, 1, 4)
  const { service } = scheduler()
  service.start()
  service.updateSettings({
    ...service.status().settings,
    enabled: false,
    questionsPerSession: 1,
    practice: { bankId: bank.id, source: 'all', wrongEvery: 0 },
  })
  expect(service.status().learning).toEqual({ level: 1, dueCount: 0 })
  for (let index = 0; index < 10; index++) {
    service.startLearning()
    study(service, { kind: 'short-answer', text: index < 8 ? 'ok' : 'no' })
  }
  const { service: restarted } = scheduler()
  restarted.start()
  expect(restarted.status().learning?.level).toBe(2)
  for (let index = 0; index < 10; index++) {
    restarted.startLearning()
    study(restarted, { kind: 'short-answer', text: index < 5 ? 'ok' : 'no' })
  }
  expect(restarted.status().learning?.level).toBe(1)
  restarted.startLearning()
  study(restarted, { kind: 'short-answer', text: 'ok' })
  expect(db.prepare('SELECT level, epoch, samples_json FROM bank_learning_profiles').all()).toEqual(
    [{ level: 1, epoch: 2, samples_json: '[]' }],
  )
  expect(createLearningEngine(db).status({ bankId: other.id, source: 'all' }, now).level).toBe(4)
})

it('does not fall back from a cooling wrong question, allows manual practice, and retains the due date on early success', () => {
  vi.useFakeTimers()
  const { id } = banks().createBank({ name: '主库' })
  const [wrong, fresh] = addQuestions(id, 2, 1)
  const { fixture, service } = scheduler()
  service.start()
  service.updateSettings({
    ...service.status().settings,
    questionsPerSession: 1,
    intervalMinutes: 5,
    mode: 'popup',
    quietHours: null,
    practice: { bankId: id, source: 'all', wrongEvery: 2 },
  })
  service.startLearning()
  expect(study(service, { kind: 'unsure' })).toBe(wrong!.id)
  const due = now + 10 * MINUTE
  expect(progress(wrong!.id)).toEqual({ step: 0, due_at: due, last_attempt_at: now })
  expect(service.status().learning?.dueCount).toBe(0)
  now += 5 * MINUTE
  vi.advanceTimersByTime(5 * MINUTE)
  expect(service.status().notice).toBe('nothing-due')
  expect(fixture.show).toHaveBeenCalledTimes(1)
  expect(progress(fresh!.id)).toBeUndefined()
  service.startLearning()
  expect(study(service, { kind: 'short-answer', text: 'ok' })).toBe(wrong!.id)
  expect(progress(wrong!.id)).toEqual({ step: 0, due_at: due, last_attempt_at: now })
  now = due
  service.startLearning()
  expect(study(service, { kind: 'short-answer', text: 'ok' })).toBe(wrong!.id)
  expect(progress(wrong!.id)).toEqual({ step: 1, due_at: now + DAY, last_attempt_at: now })
  expect(banks().queryQuestions({ bankId: id, query: '', page: 0, source: 'mistakes' }).total).toBe(
    0,
  )
  const engine = createLearningEngine(db)
  expect(engine.pick(3, { bankId: id, source: 'favorites' }, now, true).notice).toBe(
    'empty-favorites',
  )
  expect(
    engine.pick(3, { bankId: id, source: 'mistakes' }, now, false).questions.map((q) => q.id),
  ).toEqual([fresh!.id])
  service.stop()
})

it('writes progress only on a graded result, caps due intervals, and cascades on deletion', () => {
  const { id } = banks().createBank({ name: '自评' })
  const { id: questionId } = banks().createQuestion({
    bankId: id,
    question: {
      kind: 'short-answer',
      prompt: '什么是升华？',
      referenceAnswer: '直接从固体变为气体。',
    },
  })
  const { service } = scheduler()
  service.start()
  service.updateSettings({ ...service.status().settings, enabled: false })
  service.startLearning()
  const view = service.answerView()
  if (view?.kind !== 'question') throw new Error('Expected a question')
  const target = { sessionId: view.sessionId, questionId }
  service.submit({ ...target, answer: { kind: 'short-answer', text: '固体变气体' } })
  expect(progress(questionId)).toBeUndefined()
  now += MINUTE
  service.rateAnswer({ ...target, correct: true })
  service.rateAnswer({ ...target, correct: false })
  expect(progress(questionId)).toEqual({ step: 1, due_at: now + DAY, last_attempt_at: now })
  service.advance(target)
  for (const [index, interval] of [3, 7, 14, 30, 30].entries()) {
    now = Number(progress(questionId)?.due_at)
    expect(service.status().learning?.dueCount).toBe(1)
    service.startLearning()
    const next = service.answerView()
    if (next?.kind !== 'question') throw new Error('Expected a due question')
    const current = { sessionId: next.sessionId, questionId }
    service.submit({ ...current, answer: { kind: 'short-answer', text: '固体变气体' } })
    service.rateAnswer({ ...current, correct: true })
    service.advance(current)
    expect(progress(questionId)).toEqual({
      step: Math.min(2 + index, 5),
      due_at: now + interval * DAY,
      last_attempt_at: now,
    })
  }
  banks().deleteBank({ bankId: id })
  expect(progress(questionId)).toBeUndefined()
  expect(db.prepare('SELECT count(*) AS count FROM bank_learning_profiles').get()?.count).toBe(0)
})
