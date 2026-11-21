import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQuestionBankService } from '../src/application/question-bank/service'
import { parseQuestionsImport } from '../src/application/question-bank/validation'
import type { SchedulerService } from '../src/application/reminders/scheduler'
import type { LearningStrategy } from '../src/domain/progressive-learning'
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

it('deduplicates concepts across pools and fills new slots in difficulty order', () => {
  const service = banks()
  const { id } = service.createBank({ name: '词汇' })
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
  createLearningProgressWriter(db).recordAttempt({
    questionId: review.id,
    outcome: 'correct',
    at: now,
  })
  const picked = createLearningEngine(db).pick(3, { bankId: id, source: 'all' }, now).questions
  expect(picked.map((q) => [q.id, q.learning?.role, q.learning?.pool])).toEqual([
    [review.id, 'review', 'review-once'],
    [current.id, 'current', 'new'],
    [challenge.id, 'challenge', 'new'],
  ])
})

it('persists and applies independent strategies for each bank and the mixed scope', () => {
  const first = banks().createBank({ name: '随机题库' }).id
  const second = banks().createBank({ name: '渐进题库' }).id
  const [firstQuestion] = addQuestions(first, 1, 1)
  const [secondQuestion] = addQuestions(second, 1, 1)
  let { service } = scheduler()
  service.start()
  function select(bankId: string | null, strategy?: LearningStrategy) {
    return service.updateSettings({
      ...service.status().settings,
      strategy,
      practice: { bankId, source: 'all', wrongEvery: 0 },
    })
  }

  expect(select(first, 'random').settings.strategy).toBe('random')
  expect(select(second).settings.strategy).toBe('progressive')
  expect(select(second, 'progressive').settings.strategy).toBe('progressive')
  expect(select(first).settings.strategy).toBe('random')
  service.startLearning()
  expect(service.answerView()).toMatchObject({
    kind: 'question',
    question: { id: firstQuestion!.id },
  })
  expect(createReminderStore(db).load()?.session?.strategy).toBe('random')

  expect(select(second).settings.strategy).toBe('progressive')
  expect(createReminderStore(db).load()?.session?.strategy).toBe('random')
  service.windowClosed()
  service.startLearning()
  expect(service.answerView()).toMatchObject({
    kind: 'question',
    question: { id: secondQuestion!.id, pool: 'new' },
  })
  service.windowClosed()
  expect(select(null).settings.strategy).toBe('progressive')
  expect(select(null, 'random').settings.strategy).toBe('random')
  service.stop()
  db.close()
  db = openDatabase(directory)
  ;({ service } = scheduler())
  service.start()

  expect(service.status().learningStrategies).toEqual({
    allBanks: 'random',
    byBank: { [first]: 'random', [second]: 'progressive' },
  })
  expect(select(second).settings.strategy).toBe('progressive')
  expect(select(null).settings.strategy).toBe('random')
  banks().deleteBank({ bankId: first })
  expect(service.status().learningStrategies.byBank).toEqual({ [second]: 'progressive' })
  service.stop()
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
  const store = createReminderStore(db)
  function completeUntilLevel(active: SchedulerService, target: Difficulty, correctCount: number) {
    let newQuestions = 0
    for (let round = 0; round < 40 && active.status().learning?.level !== target; round++) {
      active.startLearning()
      const plan = store.load()?.session?.questions[0]?.learning
      const text = !plan?.calibrates || newQuestions++ < correctCount ? 'ok' : 'no'
      study(active, { kind: 'short-answer', text })
    }
    expect(newQuestions).toBe(10)
    expect(active.status().learning?.level).toBe(target)
  }
  completeUntilLevel(service, 2, 8)
  const { service: restarted } = scheduler()
  restarted.start()
  expect(restarted.status().learning?.level).toBe(2)
  completeUntilLevel(restarted, 1, 5)
  expect(restarted.status().learning?.level).toBe(1)
  restarted.startLearning()
  study(restarted, { kind: 'short-answer', text: 'ok' })
  expect(db.prepare('SELECT level, epoch, samples_json FROM bank_learning_profiles').all()).toEqual(
    [{ level: 1, epoch: 2, samples_json: '[]' }],
  )
  expect(createLearningEngine(db).status({ bankId: other.id, source: 'all' }, now).level).toBe(4)
})

it('schedules a mistake in the next round and moves it to review once on a correct answer', () => {
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
  expect(progress(wrong!.id)).toEqual({ step: 2, due_at: now, last_attempt_at: now })
  now += 5 * MINUTE
  vi.advanceTimersByTime(5 * MINUTE)
  expect(fixture.show).toHaveBeenCalledTimes(2)
  expect(progress(fresh!.id)).toBeUndefined()
  expect(service.answerView()).toMatchObject({
    kind: 'question',
    question: { id: wrong!.id, pool: 'mistake' },
  })
  expect(study(service, { kind: 'short-answer', text: 'ok' })).toBe(wrong!.id)
  expect(progress(wrong!.id)).toEqual({ step: 1, due_at: now, last_attempt_at: now })
  service.updateSettings({
    ...service.status().settings,
    practice: { bankId: id, source: 'mistakes', wrongEvery: 0 },
  })
  service.startLearning()
  expect(study(service, { kind: 'short-answer', text: 'ok' })).toBe(wrong!.id)
  expect(progress(wrong!.id)).toEqual({ step: 3, due_at: now, last_attempt_at: now })
  expect(banks().queryQuestions({ bankId: id, query: '', page: 0, source: 'mistakes' }).total).toBe(
    0,
  )
  const engine = createLearningEngine(db)
  expect(engine.pick(3, { bankId: id, source: 'favorites' }, now).notice).toBe('empty-favorites')
  expect(
    engine.pick(3, { bankId: id, source: 'mistakes' }, now).questions.map((q) => q.id),
  ).toEqual([fresh!.id])
  service.stop()
})

it('parks a correct first review and keeps recall out of the draw', () => {
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

  function complete(pool: string) {
    const view = service.answerView()
    if (view?.kind !== 'question') throw new Error('Expected a question')
    expect(view.question).toMatchObject({ id: questionId, pool })
    const current = { sessionId: view.sessionId, questionId }
    service.submit({ ...current, answer: { kind: 'short-answer', text: '固体变气体' } })
    service.rateAnswer({ ...current, correct: true })
    service.rateAnswer({ ...current, correct: false })
    service.advance(current)
  }
  service.startLearning()
  const first = service.answerView()
  if (first?.kind !== 'question') throw new Error('Expected the first question')
  service.submit({
    sessionId: first.sessionId,
    questionId,
    answer: { kind: 'short-answer', text: '固体变气体' },
  })
  expect(progress(questionId)).toBeUndefined()
  complete('new')
  expect(progress(questionId)).toEqual({ step: 1, due_at: now, last_attempt_at: now })
  service.startLearning()
  complete('review-once')
  const parked = { step: 3, due_at: now, last_attempt_at: now }
  expect(progress(questionId)).toEqual(parked)
  expect(service.startLearning().notice).toBe('nothing-due')
  now += 30 * DAY
  const engine = createLearningEngine(db)
  const selection = { bankId: id, source: 'all' } as const
  expect(engine.pick(3, selection, now).questions).toEqual([])
  expect(service.startLearning().notice).toBe('nothing-due')
  expect(service.status().learning?.dueCount).toBe(0)
  const writer = createLearningProgressWriter(db)
  writer.recordAttempt({ questionId, outcome: 'incorrect', at: now })
  writer.recordAttempt({ questionId, outcome: 'correct', at: now })
  expect(progress(questionId)).toEqual(parked)
  banks().deleteBank({ bankId: id })
  expect(progress(questionId)).toBeUndefined()
  expect(db.prepare('SELECT count(*) AS count FROM bank_learning_profiles').get()?.count).toBe(0)
})

it('fills a ten-question round 4/3/3 and replaces shortages with new questions first', () => {
  const { id } = banks().createBank({ name: '配额' })
  const [once, mistakes, fresh] = [
    addQuestions(id, 3, 1),
    addQuestions(id, 3, 1),
    addQuestions(id, 10, 1),
  ] as const
  const writer = createLearningProgressWriter(db)
  const answer = (questionId: string, outcome: 'correct' | 'incorrect') =>
    writer.recordAttempt({ questionId, outcome, at: now })
  for (const question of once) answer(question.id, 'correct')
  for (const question of mistakes) answer(question.id, 'incorrect')
  const engine = createLearningEngine(db)
  const selection = { bankId: id, source: 'all' } as const
  const countPools = (time = now) => {
    const counts = { new: 0, 'review-once': 0, mistake: 0, recall: 0 }
    for (const question of engine.pick(10, selection, time).questions) {
      counts[question.learning!.pool]++
    }
    return counts
  }
  expect(countPools()).toEqual({ new: 4, 'review-once': 3, mistake: 3, recall: 0 })
  for (const question of mistakes) answer(question.id, 'correct')
  expect(countPools()).toEqual({ new: 7, 'review-once': 3, mistake: 0, recall: 0 })
  for (const question of once) answer(question.id, 'correct')
  for (const question of fresh.slice(0, 3)) answer(question.id, 'incorrect')
  expect(countPools(now + DAY)).toEqual({ new: 4, 'review-once': 3, mistake: 3, recall: 0 })
  expect(engine.pick(20, selection, now + DAY).questions).toHaveLength(13)
})

it('rotates one-question rounds across all three practice pools', () => {
  const { id } = banks().createBank({ name: '每轮一道' })
  const [once, mistake] = addQuestions(id, 3, 1)
  if (!once || !mistake) throw new Error('Expected seeded questions')
  const writer = createLearningProgressWriter(db)
  writer.recordAttempt({ questionId: once.id, outcome: 'correct', at: now })
  writer.recordAttempt({ questionId: mistake.id, outcome: 'incorrect', at: now })
  const engine = createLearningEngine(db)
  const selection = { bankId: id, source: 'all' } as const
  const pools = Array.from(
    { length: 10 },
    (_, round) => engine.pick(1, selection, now, round).questions[0]?.learning?.pool,
  )
  expect(pools.filter((pool) => pool === 'new')).toHaveLength(4)
  expect(pools.filter((pool) => pool === 'review-once')).toHaveLength(3)
  expect(pools.filter((pool) => pool === 'mistake')).toHaveLength(3)
})

it('migrates saved progress and removes the retired review interval from v12 settings', () => {
  const { id } = banks().createBank({ name: '旧复习进度' })
  const [once, twice, recall, retry] = addQuestions(id, 4, 1)
  db.exec(`
    DROP TABLE bank_learning_strategies;
    ALTER TABLE question_learning ADD COLUMN last_correct_round INTEGER;
    PRAGMA user_version = 12;
  `)
  const insert = db.prepare('INSERT INTO question_learning VALUES (?, ?, ?, ?, ?)')
  insert.run(once!.id, 1, now + DAY, now, 6)
  insert.run(twice!.id, 2, now + 3 * DAY, now, 5)
  insert.run(recall!.id, 3, now + 7 * DAY, now, 4)
  insert.run(retry!.id, 0, now + 10 * MINUTE, now, null)
  db.prepare('INSERT INTO correctly_answered_questions VALUES (?)').run(retry!.id)
  db.prepare('INSERT INTO reminder_state VALUES (1, ?)').run(
    JSON.stringify({
      settings: { strategy: 'progressive', reviewAfterRounds: 3 },
      completedRounds: 7,
      session: null,
    }),
  )

  db.close()
  db = openDatabase(directory)
  expect(progress(once!.id)).toMatchObject({ step: 1, due_at: now })
  expect(progress(twice!.id)).toMatchObject({ step: 1, due_at: now })
  expect(progress(recall!.id)).toMatchObject({ step: 3, due_at: now + DAY })
  expect(progress(retry!.id)).toMatchObject({ step: 2, due_at: now })
  expect(createReminderStore(db).load()).toEqual({
    settings: { strategy: 'progressive' },
    completedRounds: 7,
    session: null,
  })
})

it('migrates old second reviews and mistakes without discarding the current session', () => {
  const { id } = banks().createBank({ name: '旧题池' })
  const [review, mistake, fresh] = addQuestions(id, 3, 1)
  if (!review || !mistake || !fresh) throw new Error('Expected seeded questions')
  const progressRow = db.prepare('INSERT INTO question_learning VALUES (?, ?, ?, ?)')
  progressRow.run(review.id, 2, now, now)
  progressRow.run(mistake.id, 2, now + 10 * MINUTE, now)
  db.prepare('INSERT INTO wrong_questions VALUES (?, 0)').run(mistake.id)
  const snapshot = {
    session: {
      questions: [
        { id: review.id, learning: { pool: 'review-twice' } },
        { id: fresh.id, learning: { pool: 'new' } },
      ],
      index: 1,
    },
  }
  db.prepare('INSERT INTO reminder_state VALUES (1, ?)').run(JSON.stringify(snapshot))
  db.exec('DROP TABLE bank_learning_strategies; PRAGMA user_version = 13')
  db.close()
  db = openDatabase(directory)

  expect(progress(review.id)).toMatchObject({ step: 1, due_at: now })
  expect(progress(mistake.id)).toMatchObject({ step: 2, due_at: now })
  expect(createReminderStore(db).load()?.session).toEqual({
    ...snapshot.session,
    questions: [
      { id: review.id, learning: { pool: 'review-once' } },
      snapshot.session.questions[1],
    ],
  })
})
