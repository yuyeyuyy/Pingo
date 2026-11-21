import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createQuestionBankService } from '../src/application/question-bank/service'
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
import {
  createStudyMaterialSampler,
  createStudyMaterialSource,
} from '../src/infrastructure/database/study-material-source'
import { schedulerFixture } from './helpers/reminders'

let directory: string
let database: ReturnType<typeof openDatabase>

const apple = {
  key: 'apple',
  title: 'apple',
  explanation: '名词。苹果。',
  examples: [{ text: 'I ate an apple.', translation: '我吃了一个苹果。' }],
}
const pear = { key: 'pear', title: 'pear', explanation: '名词。梨。' }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pingo-study-'))
  database = openDatabase(directory)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

function banks() {
  return createQuestionBankService(createQuestionBankRepository(database), randomUUID)
}

function scheduler(now = Date.now) {
  const store = createReminderStore(database)
  const fixture = schedulerFixture({
    store,
    questions: createLearningQuestionSource(database),
    learning: createLearningEngine(database),
    studyMaterials: createStudyMaterialSource(database),
    sampleStudyMaterials: createStudyMaterialSampler(database),
    now,
    schedule: () => () => {},
    makeId: randomUUID,
  })
  const service = fixture.create()
  service.start()
  return { fixture, store, service }
}

function question(prompt: string, materialKey?: string) {
  return {
    kind: 'multiple-choice',
    prompt,
    options: ['对', '错'],
    correctOptionIndex: 0,
    difficulty: 1,
    ...(materialKey ? { materialKey, conceptKey: materialKey } : {}),
  } as const
}

it.each(['random', 'progressive'] as const)(
  'completes a materials-only round without questions using the %s strategy',
  (strategy) => {
    const { id: bankId } = banks().createBank({ name: '纯学习词表', template: 'language' })
    const { service, store, fixture } = scheduler()
    service.updateSettings({
      ...service.status().settings,
      sessionMode: 'learn',
      questionsPerSession: 2,
      strategy,
      practice: { bankId, source: 'all', wrongEvery: 1 },
    })
    expect(service.startLearning().notice).toBe('empty-materials')
    expect(fixture.show).not.toHaveBeenCalled()

    banks().appendQuestionImport({ bankId, json: JSON.stringify({ materials: [apple, pear] }) })
    service.questionsAdded()
    expect(service.status().notice).toBeNull()
    service.startLearning()
    const first = service.answerView()
    if (first?.kind !== 'material') throw new Error('Expected the first study card')
    expect(first).toMatchObject({ materialsOnly: true, total: 2, material: { language: 'en' } })
    expect(store.load()?.session).toMatchObject({ strategy, questions: [], answers: [] })
    expect(service.status().learning).toBeUndefined()
    expect(service.advanceStudyMaterial({ sessionId: first.sessionId, position: 2 })).toEqual(first)
    const second = service.advanceStudyMaterial({ sessionId: first.sessionId, position: 1 })
    expect(second).toMatchObject({ kind: 'material', materialsOnly: true, position: 2 })
    if (second?.kind !== 'material') throw new Error('Expected the second study card')
    expect(new Set([first.material.key, second.material.key])).toEqual(new Set(['apple', 'pear']))

    service.snooze(first.sessionId, 5)
    service.stop()
    database.close()
    database = openDatabase(directory)
    const reopened = scheduler()
    reopened.service.startLearning()
    expect(reopened.service.answerView()).toEqual(second)
    expect(
      reopened.service.advanceStudyMaterial({ sessionId: first.sessionId, position: 2 }),
    ).toEqual({
      kind: 'summary',
      materialsOnly: true,
      sessionId: first.sessionId,
      total: 2,
    })
    expect(reopened.store.load()?.session).toBeNull()
    expect(reopened.store.load()?.completedInCycle ?? 0).toBe(0)
    expect(reopened.store.load()?.completedRounds ?? 0).toBe(0)
    expect(database.prepare('SELECT count(*) AS count FROM question_learning').get()?.count).toBe(0)
    expect(database.prepare('SELECT outcome FROM learning_history').all()).toEqual([
      { outcome: 'completed' },
    ])
  },
)

it('prioritizes unseen materials then difficulty, deduplicates words, and respects the bank and review scope', () => {
  const bankService = banks()
  const { id: bankId } = bankService.createBank({ name: '词汇', template: 'language' })
  const otherBank = bankService.createBank({ name: '其他题库' }).id
  const difficult = { key: 'mitigate', title: 'mitigate', explanation: '缓和' }
  bankService.appendQuestionImport({
    bankId,
    json: JSON.stringify({
      materials: [difficult, apple, { ...apple, key: 'another-apple', title: 'APPLE' }, pear],
      questions: [
        { ...question('高难度词', difficult.key), difficulty: 5 },
        question('梨', pear.key),
      ],
    }),
  })
  bankService.appendQuestionImport({
    bankId: otherBank,
    json: JSON.stringify({ materials: [apple] }),
  })
  const sample = createStudyMaterialSampler(database)
  const scope = { bankId, source: 'all' } as const
  expect(sample(10, scope, 'progressive').map(({ key }) => key)).toEqual([
    'apple',
    'pear',
    'mitigate',
  ])
  const { service } = scheduler()
  service.updateSettings({
    ...service.status().settings,
    sessionMode: 'learn',
    questionsPerSession: 1,
    practice: { ...scope, wrongEvery: 0 },
  })
  service.startLearning()
  expect(service.answerView()).toMatchObject({ kind: 'material', material: { key: 'apple' } })
  service.windowClosed()
  expect(sample(3, scope, 'progressive').map(({ key }) => key)).toEqual([
    'pear',
    'mitigate',
    'apple',
  ])
  expect(sample(2, { bankId, source: 'favorites' }, 'random')).toEqual([])
  expect(sample(3, { bankId, source: 'mistakes' }, 'progressive')).toHaveLength(3)
  const pearQuestion = bankService
    .listQuestions({ bankId })
    .find(({ materialKey }) => materialKey === 'pear')!
  expect(createReminderStore(database).setFavorite(pearQuestion.id, true)).toBe(true)
  expect(sample(2, { bankId, source: 'favorites' }, 'random').map(({ key }) => key)).toEqual([
    'pear',
  ])
  expect(sample(10, { bankId: null, source: 'all' }, 'random')).toHaveLength(4)
})

it('links multiple questions to a bank-scoped material and rolls back failed imports', () => {
  const service = banks()
  const bank = service.createBank({ name: '词表' })
  const other = service.createBank({ name: '其他题库' })
  const append = (bankId: string, data: object) =>
    service.appendQuestionImport({ bankId, json: JSON.stringify(data) })
  expect(
    append(bank.id, {
      materials: [{ ...apple, key: ' Apple ' }],
      questions: [question('第一题', 'APPLE'), question('第二题', 'apple')],
    }),
  ).toEqual({ added: 2, materials: 1 })
  const items = service.listQuestions({ bankId: bank.id })
  expect(items.map(({ materialKey }) => materialKey)).toEqual(['apple', 'apple'])
  expect(append(bank.id, { materials: [{ ...apple, explanation: '更新后的讲解' }] })).toEqual({
    added: 0,
    materials: 1,
  })
  const read = createStudyMaterialSource(database)
  expect(read(items.map(({ id }) => id))).toEqual([
    {
      ...apple,
      explanation: '更新后的讲解',
      bankName: bank.name,
      subject: { bankId: bank.id, key: 'apple' },
    },
  ])
  expect(() =>
    append(bank.id, {
      materials: [apple, pear],
      questions: [question('可关联', 'pear'), question('链接无效', 'missing')],
    }),
  ).toThrow('missing')
  expect(database.prepare('SELECT key FROM study_materials').all()).toEqual([{ key: 'apple' }])
  expect(service.listQuestions({ bankId: bank.id })).toEqual(items)
  expect(read(items.map(({ id }) => id))[0]?.explanation).toBe('更新后的讲解')
  expect(() => append(other.id, { questions: [question('跨库链接', 'apple')] })).toThrow('apple')
  expect(() => append(other.id, { materials: [apple, { ...apple, key: 'APPLE' }] })).toThrow('重复')
  expect(() => append(other.id, { materials: [{ ...apple, examples: [{ text: '' }] }] })).toThrow(
    '例句或示例',
  )
  expect(append(other.id, { materials: [apple] })).toEqual({ added: 0, materials: 1 })
  service.deleteBank({ bankId: bank.id })
  expect(database.prepare('SELECT bank_id FROM study_materials').all()).toEqual([
    { bank_id: other.id },
  ])
  expect(read(items.map(({ id }) => id))).toEqual([])
})

it('presents the shared material once, persists the reading snapshot and only then accepts answers', () => {
  const { id: bankId } = banks().createBank({ name: '学习题库' })
  banks().appendQuestionImport({
    bankId,
    json: JSON.stringify({
      materials: [apple, pear],
      questions: [
        question('未关联题'),
        question('苹果一', 'apple'),
        question('苹果二', 'apple'),
        question('梨一', 'pear'),
        question('超出题量', 'pear'),
      ],
    }),
  })
  const { service, store } = scheduler()
  service.updateSettings({
    ...service.status().settings,
    sessionMode: 'study',
    questionsPerSession: 3,
    practice: { bankId, source: 'all', wrongEvery: 0 },
  })
  service.startLearning()
  const first = service.answerView()
  if (first?.kind !== 'material') throw new Error('Expected a material')
  expect(first).toMatchObject({ position: 1, total: 2, material: apple })
  const session = store.load()?.session
  const target = { sessionId: first.sessionId, questionId: session!.questions[0]!.id }
  expect(session?.questions.map(({ prompt }) => prompt)).toEqual(['苹果一', '梨一'])
  expect(
    service.submit({ ...target, answer: { kind: 'multiple-choice', optionIndex: 0 } }),
  ).toEqual(first)
  expect(store.load()?.session?.answers).toEqual([])
  expect(service.advanceStudyMaterial({ sessionId: first.sessionId, position: 2 })).toEqual(first)
  const second = service.advanceStudyMaterial({ sessionId: first.sessionId, position: 1 })
  expect(second).toMatchObject({
    kind: 'material',
    position: 2,
    material: { ...pear, examples: [] },
  })
  expect(service.advanceStudyMaterial({ sessionId: first.sessionId, position: 1 })).toEqual(second)

  service.snooze(first.sessionId, 5)
  expect(service.status().phase).toBe('SNOOZED')
  service.stop()
  database.close()
  database = openDatabase(directory)
  banks().appendQuestionImport({
    bankId,
    json: JSON.stringify({
      materials: [{ ...pear, explanation: '重启后修改的讲解' }],
    }),
  })
  const { service: restarted, store: reopened } = scheduler()
  restarted.updateSettings({
    ...restarted.status().settings,
    sessionMode: 'practice',
    strategy: 'random',
  })
  restarted.startLearning()
  expect(restarted.answerView()).toEqual(second)
  const firstQuestion = restarted.advanceStudyMaterial({ sessionId: first.sessionId, position: 2 })
  expect(firstQuestion).toMatchObject({
    kind: 'question',
    position: 1,
    total: 2,
    question: { id: target.questionId },
  })
  expect(restarted.advanceStudyMaterial({ sessionId: first.sessionId, position: 2 })).toEqual(
    firstQuestion,
  )
  for (const item of session!.questions) {
    const questionTarget = { sessionId: first.sessionId, questionId: item.id }
    restarted.submit({ ...questionTarget, answer: { kind: 'multiple-choice', optionIndex: 0 } })
    restarted.advance(questionTarget)
  }
  expect(restarted.answerView()).toMatchObject({ kind: 'summary', total: 2, correct: 2 })
  expect(reopened.load()?.session).toBeNull()
  restarted.startLearning()
  expect(restarted.answerView()).toMatchObject({ kind: 'question' })
})

it.each(['random', 'progressive'] as const)(
  'shows study cards for new questions and progressive mistakes with the %s strategy',
  (strategy) => {
    const bankService = banks()
    const { id: bankId } = bankService.createBank({ name: '词汇', template: 'language' })
    const append = (data: object) =>
      bankService.appendQuestionImport({ bankId, json: JSON.stringify(data) })
    append({ materials: [apple], questions: [question('apple 释义', 'apple')] })
    const [recognition] = bankService.listQuestions({ bankId })

    let now = Date.now()
    const { service, store } = scheduler(() => now)
    const practice = { bankId, source: 'all', wrongEvery: 0 } as const
    service.updateSettings({
      ...service.status().settings,
      sessionMode: 'study',
      questionsPerSession: 2,
      strategy,
      practice,
    })
    service.startLearning()
    const first = service.answerView()
    if (first?.kind !== 'material') throw new Error('Expected the initial study card')
    service.advanceStudyMaterial({ sessionId: first.sessionId, position: 1 })
    const target = { sessionId: first.sessionId, questionId: recognition!.id }
    const firstQuestion = store.load()?.session?.questions[0]
    if (firstQuestion?.kind !== 'multiple-choice') throw new Error('Expected a choice question')
    expect(
      service.submit({
        ...target,
        answer: { kind: 'multiple-choice', optionIndex: firstQuestion.correctOptionIndex },
      }),
    ).toMatchObject({ feedback: { outcome: 'correct' } })
    service.advance(target)

    now += 86_400_000
    service.startLearning()
    const review = service.answerView()
    expect(review).toMatchObject({
      kind: 'question',
      total: 1,
      question: { id: target.questionId },
    })
    if (review?.kind !== 'question') throw new Error('Expected the review question')
    const reviewTarget = { ...target, sessionId: review.sessionId }
    service.submit({ ...reviewTarget, answer: { kind: 'unsure' } })
    service.advance(reviewTarget)

    now += 10 * 60_000
    append({ materials: [pear], questions: [question('pear 释义', 'pear')] })
    service.startLearning()
    const mixed = service.answerView()
    const expectedCards = strategy === 'progressive' ? ['apple', 'pear'] : ['pear']
    expect(mixed).toMatchObject({ kind: 'material', total: expectedCards.length })
    expect(
      store
        .load()
        ?.session?.study?.materials.map(({ key }) => key)
        .sort(),
    ).toEqual(expectedCards)
    expect(
      store
        .load()
        ?.session?.questions.map(({ prompt }) => prompt)
        .sort(),
    ).toEqual(['apple 释义', 'pear 释义'])
    if (mixed?.kind !== 'material') throw new Error('Expected study cards')
    let next = service.answerView()
    for (let position = 1; position <= expectedCards.length; position++) {
      next = service.advanceStudyMaterial({ sessionId: mixed.sessionId, position })
    }
    expect(next).toMatchObject({ kind: 'question', total: 2 })
    if (strategy === 'progressive') {
      expect(next).toMatchObject({ question: { id: target.questionId, pool: 'mistake' } })
    }
    service.windowClosed()

    append({ questions: [{ kind: 'short-answer', prompt: 'apple 拼写', materialKey: 'apple' }] })
    const spelling = bankService
      .listQuestions({ bankId })
      .find(({ prompt }) => prompt === 'apple 拼写')!
    expect(store.setFavorite(spelling.id, true)).toBe(true)
    service.updateSettings({
      ...service.status().settings,
      practice: { ...practice, source: 'favorites' },
    })
    service.startLearning()
    const spellingCard = service.answerView()
    expect(spellingCard).toMatchObject({ kind: 'material', total: 1, material: { key: 'apple' } })
    if (spellingCard?.kind !== 'material')
      throw new Error('Expected a card for the spelling exercise')
    service.advanceStudyMaterial({ sessionId: spellingCard.sessionId, position: 1 })
    const spellingTarget = { sessionId: spellingCard.sessionId, questionId: spelling.id }
    expect(
      service.submit({ ...spellingTarget, answer: { kind: 'short-answer', text: 'apple' } }),
    ).toMatchObject({
      feedback: { outcome: 'ungraded' },
    })
    service.advance(spellingTarget)
    service.startLearning()
    expect(service.answerView()).toMatchObject({ kind: 'material', material: { key: 'apple' } })
  },
)

it.each(['random', 'progressive'] as const)(
  'pairs one question with each of five materials using the %s strategy',
  (strategy) => {
    const { id: bankId } = banks().createBank({ name: '词汇' })
    const materials = [
      apple,
      pear,
      { key: 'borrow', title: 'borrow', explanation: '借入' },
      { key: 'explain', title: 'explain', explanation: '解释' },
      { key: 'mitigate', title: 'mitigate', explanation: '减轻' },
      { key: 'elusive', title: 'elusive', explanation: '难以捉摸的' },
    ]
    banks().appendQuestionImport({
      bankId,
      json: JSON.stringify({
        materials,
        questions: [
          ...materials.map(({ key }, index) => ({
            ...question(`${key} 选择`, key),
            difficulty: Math.min(index + 1, 5),
          })),
          ...materials.map(({ key }) => ({ ...question(`${key} 进阶`, key), difficulty: 5 })),
        ],
      }),
    })
    const byId = new Map(
      banks()
        .listQuestions({ bankId })
        .map((item) => [item.id, item]),
    )
    const review = [...byId.values()].find(({ prompt }) => prompt === 'apple 进阶')!
    createLearningProgressWriter(database).recordAttempt({
      questionId: review.id,
      outcome: 'incorrect',
      at: Date.now() - 11 * 60_000,
    })
    const { service, store } = scheduler()
    service.updateSettings({
      ...service.status().settings,
      sessionMode: 'study',
      questionsPerSession: 5,
      strategy,
      practice: { bankId, source: 'all', wrongEvery: 0 },
    })
    service.startLearning()
    expect(service.answerView()).toMatchObject({ kind: 'material', total: 5 })
    const session = store.load()?.session
    const questionKeys = session?.questions.map(({ id }) => byId.get(id)?.materialKey)
    expect(new Set(questionKeys).size).toBe(5)
    expect(session?.study?.materials.map(({ key }) => key)).toEqual(questionKeys)
    if (strategy === 'progressive') {
      expect(session?.questions[0]?.id).toBe(review.id)
      expect(questionKeys).toEqual(['apple', 'pear', 'borrow', 'explain', 'mitigate'])
    }

    service.windowClosed()
    service.updateSettings({ ...service.status().settings, questionsPerSession: 10 })
    service.startLearning()
    expect(service.answerView()).toMatchObject({ kind: 'material', total: 6 })
    expect(store.load()?.session?.questions).toHaveLength(6)
  },
)

it.each(['random', 'progressive'] as const)(
  'draws unseen words across consecutive %s rounds even if each word has different cards and exercises',
  (strategy) => {
    const { id: bankId } = banks().createBank({ name: '词汇轮换', template: 'language' })
    const words = [
      'apple',
      'pear',
      'borrow',
      'rain',
      'sun',
      'tree',
      'grass',
      'river',
      'cloud',
      'star',
      'room',
      'chair',
    ]
    banks().appendQuestionImport({
      bankId,
      json: JSON.stringify({
        materials: words.flatMap((word) => [
          { key: `${word}:first`, title: word, explanation: '词义一' },
          { key: `${word}:second`, title: word.toUpperCase(), explanation: '词义二' },
        ]),
        questions: words.flatMap((word) => [
          question(`${word} 识别`, `${word}:first`),
          { ...question(`${word} 应用`, `${word}:first`), difficulty: 2 },
          { ...question(`${word} 变体`, `${word}:second`), difficulty: 2 },
        ]),
      }),
    })
    let { service, store } = scheduler()
    service.updateSettings({
      ...service.status().settings,
      sessionMode: 'study',
      questionsPerSession: 5,
      strategy,
      practice: { bankId, source: 'all', wrongEvery: 0 },
    })
    function readRound() {
      service.startLearning()
      const session = store.load()?.session
      const subjects = session?.study?.materials.map(({ subject }) => subject?.key)
      expect(subjects).toHaveLength(5)
      expect(new Set(subjects).size).toBe(5)
      for (let position = 1; position <= 5; position++) {
        service.advanceStudyMaterial({ sessionId: session!.id, position })
      }
      expect(service.answerView()).toMatchObject({ kind: 'question', total: 5 })
      service.windowClosed()
      return subjects!
    }

    const first = readRound()
    expect(database.prepare('SELECT count(*) AS n FROM learning_history').get()?.n).toBe(0)
    service.stop()
    database.close()
    database = openDatabase(directory)
    const resumed = scheduler()
    service = resumed.service
    store = resumed.store
    const second = readRound()
    const alreadySeen = new Set([...first, ...second])
    expect(alreadySeen.size).toBe(10)
    const third = readRound()
    expect(third.filter((word) => !alreadySeen.has(word))).toHaveLength(2)
    expect(database.prepare('SELECT count(*) AS n FROM study_material_progress').get()?.n).toBe(12)
  },
)

it('backfills vocabulary progress from v8 history and the current reading position', () => {
  const { id: bankId } = banks().createBank({ name: '旧词库', template: 'language' })
  const variants = [apple, pear, { key: 'sun', title: 'sun', explanation: '太阳' }]
  banks().appendQuestionImport({
    bankId,
    json: JSON.stringify({
      materials: variants,
      questions: variants.map(({ key }) => question(key, key)),
    }),
  })
  const questions = banks().listQuestions({ bankId })
  const snapshots = createStudyMaterialSource(database)(questions.map(({ id }) => id))
  const saveHistory = database.prepare(
    "INSERT INTO learning_history (session_id, ended_at, outcome, payload) VALUES ('old', 100, 'completed', ?)",
  )
  saveHistory.run(
    JSON.stringify({
      questions: questions.slice(0, 1),
      study: { index: 1, materials: [snapshots[0]] },
    }),
  )
  database.prepare('INSERT INTO reminder_state VALUES (1, ?)').run(
    JSON.stringify({
      session: {
        startedAt: 200,
        stage: 'snoozed',
        questions: questions.slice(1),
        study: { index: 0, materials: snapshots.slice(1) },
      },
    }),
  )
  database.exec(
    `DROP TABLE bank_learning_strategies;
    DROP TABLE correctly_answered_questions;
    DROP TABLE study_material_progress;
    ALTER TABLE question_banks DROP COLUMN language;
    PRAGMA user_version = 8`,
  )
  database.close()
  database = openDatabase(directory)

  expect(
    database
      .prepare('SELECT subject_key, last_seen_at FROM study_material_progress ORDER BY subject_key')
      .all(),
  ).toEqual([
    { subject_key: 'apple', last_seen_at: 100 },
    { subject_key: 'pear', last_seen_at: 200 },
  ])
})

it('backfills correct answers from v10 history, the current session, and review progress', () => {
  const bankService = banks()
  const { id: bankId } = bankService.createBank({ name: '旧题库' })
  const addQuestion = (prompt: string) =>
    bankService.createQuestion({ bankId, question: question(prompt) }).id
  const historical = addQuestion('答对后答错')
  const inProgress = addQuestion('本轮答对')
  const scheduled = addQuestion('复习进度')
  const incorrect = addQuestion('只答错过')
  const result = (questionId: string, outcome: string) => ({ questionId, feedback: { outcome } })
  createLearningProgressWriter(database).recordAttempt({
    questionId: scheduled,
    at: 1,
    outcome: 'correct',
  })
  const archive = database.prepare("INSERT INTO learning_history VALUES (?, ?, 'completed', ?)")
  archive.run(
    'first',
    1,
    JSON.stringify({
      answers: [result(historical, 'correct'), result('deleted-question', 'correct')],
    }),
  )
  archive.run(
    'second',
    2,
    JSON.stringify({ answers: [result(historical, 'incorrect'), result(incorrect, 'incorrect')] }),
  )
  database.prepare('INSERT INTO reminder_state VALUES (1, ?)').run(
    JSON.stringify({
      session: { answers: [result(inProgress, 'correct')] },
    }),
  )
  database.exec(`DROP TABLE bank_learning_strategies;
    DROP TABLE correctly_answered_questions;
    PRAGMA user_version = 10`)
  database.close()
  database = openDatabase(directory)

  const store = createReminderStore(database)
  expect(
    store.correctlyAnsweredQuestionIds([
      historical,
      inProgress,
      scheduled,
      incorrect,
      'deleted-question',
    ]),
  ).toEqual(new Set([historical, inProgress, scheduled]))
  const reviewStages = database.prepare('SELECT question_id, step FROM question_learning').all()
  expect(new Map(reviewStages.map((row) => [row.question_id, row.step]))).toEqual(
    new Map([
      [historical, 1],
      [inProgress, 1],
      [scheduled, 1],
    ]),
  )
})

it('reserves a study question for review while only showing new cards', () => {
  const { id: bankId } = banks().createBank({ name: '分题池复习词库' })
  const append = (materials: readonly { key: string; title: string; explanation: string }[]) =>
    banks().appendQuestionImport({
      bankId,
      json: JSON.stringify({
        materials,
        questions: materials.map(({ key }) => ({
          kind: 'short-answer',
          prompt: key,
          acceptedAnswers: ['ok'],
          materialKey: key,
        })),
      }),
    })
  append([apple])
  const appleQuestion = banks().listQuestions({ bankId })[0]!
  const now = Date.now()
  const { service, store } = scheduler(() => now)
  service.updateSettings({
    ...service.status().settings,
    sessionMode: 'study',
    strategy: 'progressive',
    questionsPerSession: 3,
    practice: { bankId, source: 'all', wrongEvery: 0 },
  })
  service.startLearning()
  const first = service.answerView()
  if (first?.kind !== 'material') throw new Error('Expected the first study card')
  service.advanceStudyMaterial({ sessionId: first.sessionId, position: 1 })
  const target = { sessionId: first.sessionId, questionId: appleQuestion.id }
  service.submit({ ...target, answer: { kind: 'short-answer', text: 'ok' } })
  service.advance(target)

  append([
    pear,
    { key: 'sun', title: 'sun', explanation: '太阳' },
    { key: 'moon', title: 'moon', explanation: '月亮' },
  ])
  service.startLearning()
  expect(service.answerView()).toMatchObject({ kind: 'material', total: 2 })
  expect(store.load()?.session?.study?.materials[0]?.key).not.toBe(apple.key)
  expect(store.load()?.session?.questions).toMatchObject([
    { id: appleQuestion.id, learning: { pool: 'review-once' } },
    { learning: { pool: 'new' } },
    { learning: { pool: 'new' } },
  ])
})

it.each(['random', 'progressive'] as const)(
  'only starts a study round with linked questions using the %s strategy',
  (strategy) => {
    const { id: bankId } = banks().createBank({ name: '已有题库' })
    const unlinked = banks().createQuestion({ bankId, question: question('旧题') })
    const { service, fixture, store } = scheduler()
    service.updateSettings({
      ...service.status().settings,
      strategy,
      practice: { bankId, source: 'all', wrongEvery: 0 },
    })
    service.startLearning()
    expect(service.answerView()).toMatchObject({ kind: 'question', question: { id: unlinked.id } })
    service.windowClosed()
    service.updateSettings({ ...service.status().settings, sessionMode: 'study' })
    expect(service.startLearning().notice).toBe('empty-study')
    expect(fixture.show).toHaveBeenCalledOnce()
    const { id: otherBankId } = banks().createBank({ name: '其他题库' })
    for (const targetBank of [bankId, otherBankId]) {
      banks().appendQuestionImport({
        bankId: targetBank,
        json: JSON.stringify({
          materials: [apple],
          questions: [question('带资料的题', 'apple')],
        }),
      })
    }
    const linked = banks().listQuestions({ bankId })[1]!
    store.setFavorite(unlinked.id, true)
    service.updateSettings({
      ...service.status().settings,
      practice: { bankId, source: 'favorites', wrongEvery: 0 },
    })
    expect(service.startLearning().notice).toBe('empty-study')
    store.setFavorite(linked.id, true)
    expect(service.startLearning().notice).toBeNull()
    expect(service.answerView()).toMatchObject({
      kind: 'material',
      total: 1,
      material: { bankName: '已有题库' },
    })
    expect(store.load()?.session?.questions.map(({ id }) => id)).toEqual([linked.id])
  },
)
