import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createQuestionBankService } from '../src/application/question-bank/service'
import { openDatabase } from '../src/infrastructure/database/open'
import { createQuestionBankRepository } from '../src/infrastructure/database/question-bank-repository'
import {
  createLearningQuestionSource,
  createReminderStore,
} from '../src/infrastructure/database/reminder-store'
import { schedulerFixture } from './helpers/reminders'

let directory: string
let db: ReturnType<typeof openDatabase>
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pingo-reminders-'))
  db = openDatabase(directory)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

it('persists pronunciation preferences independently of reminder settings and exposes them to study views', () => {
  const fixture = schedulerFixture({ store: createReminderStore(db), schedule: () => () => {} })
  const service = fixture.create()
  service.start()
  service.startLearning()
  const original = service.answerView()
  const preferences = { voiceURI: 'local-voice', rate: 0.85, source: 'system' } as const
  service.updatePronunciation(preferences)
  expect(service.answerView()).toEqual({ ...original, pronunciationPreferences: preferences })
  service.updateSettings({ ...service.status().settings, intervalMinutes: 45 })
  service.stop()
  db.close()
  db = openDatabase(directory)
  const reopened = schedulerFixture({ store: createReminderStore(db) }).create()
  expect(reopened.status().pronunciation).toEqual(preferences)
  expect(reopened.status().settings.intervalMinutes).toBe(45)
})

it('copies the v14 global strategy to existing banks during upgrade', () => {
  const bankService = () => createQuestionBankService(createQuestionBankRepository(db), randomUUID)
  const first = bankService().createBank({ name: '旧题库一' }).id
  const second = bankService().createBank({ name: '旧题库二' }).id
  const fixture = schedulerFixture({ store: createReminderStore(db), schedule: () => () => {} })
  const service = fixture.create()
  service.updateSettings({ ...service.status().settings, strategy: 'random' })
  service.stop()
  db.exec('DROP TABLE bank_learning_strategies; PRAGMA user_version = 14')
  db.close()
  db = openDatabase(directory)

  const restored = schedulerFixture({
    store: createReminderStore(db),
    schedule: () => () => {},
  }).create()
  const status = restored.updateSettings({ ...restored.status().settings, strategy: 'progressive' })
  expect(status.learningStrategies).toEqual({
    allBanks: 'progressive',
    byBank: { [first]: 'random', [second]: 'random' },
  })
  const third = bankService().createBank({ name: '新题库' }).id
  const selected = restored.updateSettings({
    ...status.settings,
    strategy: undefined,
    practice: { bankId: third, source: 'all', wrongEvery: 0 },
  })
  expect(selected.settings.strategy).toBe('progressive')
})

it('keeps v3 bank and question IDs, saved sessions, and history when adding bank templates', () => {
  const oldFolder = mkdtempSync(join(directory, 'legacy-'))
  const legacy = new DatabaseSync(join(oldFolder, 'pingo.sqlite'))
  const snapshot = {
    id: 'saved-session',
    questions: [
      {
        id: 'choice',
        kind: 'multiple-choice',
        prompt: '旧选择题',
        options: ['甲', '乙'],
        correctOptionIndex: 1,
      },
    ],
    answers: [
      {
        questionId: 'choice',
        feedback: { kind: 'multiple-choice', selected: 1, correct: 1, outcome: 'correct' },
      },
    ],
  }
  try {
    legacy.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE question_banks (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
      CREATE TABLE questions (
        id TEXT PRIMARY KEY, bank_id TEXT REFERENCES question_banks(id),
        kind TEXT NOT NULL, prompt TEXT NOT NULL, options_json TEXT,
        correct_option_index INTEGER, reference_answer TEXT
      ) STRICT;
      CREATE INDEX questions_bank_id ON questions (bank_id);
      CREATE TABLE reminder_state (singleton INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT;
      CREATE TABLE learning_history (session_id TEXT PRIMARY KEY, ended_at INTEGER, outcome TEXT, payload TEXT) STRICT;
      INSERT INTO question_banks VALUES ('old-bank','科学');
      INSERT INTO questions VALUES ('choice','old-bank','multiple-choice','旧选择题','["甲","乙"]',1,NULL);
      INSERT INTO questions VALUES ('written','old-bank','short-answer','旧填写题',NULL,NULL,'参考文本');
    `)
    legacy
      .prepare('INSERT INTO reminder_state VALUES (1, ?)')
      .run(JSON.stringify({ session: snapshot }))
    legacy
      .prepare("INSERT INTO learning_history VALUES ('done', 1, 'completed', ?)")
      .run(JSON.stringify(snapshot))
  } finally {
    legacy.close()
  }

  const migrated = openDatabase(oldFolder)
  try {
    expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(15)
    expect(createReminderStore(migrated).load()?.session).toEqual(snapshot)
    expect(
      migrated.prepare("SELECT payload FROM learning_history WHERE session_id = 'done'").get()
        ?.payload,
    ).toBe(JSON.stringify(snapshot))
    const banks = createQuestionBankRepository(migrated)
    expect(banks.listBanks()).toEqual([{ id: 'old-bank', name: '科学', template: 'basic' }])
    expect(banks.listQuestions('old-bank')).toEqual([
      snapshot.questions[0],
      { id: 'written', kind: 'short-answer', prompt: '旧填写题', referenceAnswer: '参考文本' },
    ])
    expect(
      createLearningQuestionSource(migrated)(20)
        .map((question) => question.id)
        .sort(),
    ).toEqual(['choice', 'written'])
  } finally {
    migrated.close()
  }
})

it('samples real questions and persists partial answers and the next reminder across SQLite reopen', () => {
  let store = createReminderStore(db)
  const banks = createQuestionBankService(createQuestionBankRepository(db), randomUUID)
  const bank = banks.importQuestionBank(
    JSON.stringify({
      name: '科学',
      questions: [
        { kind: 'short-answer', prompt: '解释凝固。', referenceAnswer: '液体变为固体。' },
        { kind: 'short-answer', prompt: '解释蒸发。' },
      ],
    }),
  )
  const source = createLearningQuestionSource(db)
  const sample = source(20)
  expect(new Set(sample.map((question) => question.id)).size).toBe(2)

  const fixture = schedulerFixture({
    store,
    questions: () => [sample[0]!],
    schedule: () => () => {},
  })
  const service = fixture.create()
  service.start()
  service.startLearning()
  const view = service.answerView()
  if (view?.kind !== 'question') throw new Error('Expected a question')
  service.submit({
    sessionId: view.sessionId,
    questionId: view.question.id,
    answer: { kind: 'short-answer', text: '我的答案' },
  })
  service.stop()

  db.close()
  db = openDatabase(directory)
  store = createReminderStore(db)
  expect(store.load()?.session?.answers).toMatchObject([
    { questionId: view.question.id, feedback: { outcome: 'ungraded', text: '我的答案' } },
  ])
  const restarted = schedulerFixture({
    store,
    questions: createLearningQuestionSource(db),
    schedule: () => () => {},
  }).create()
  restarted.start()
  expect(restarted.status().pendingSessionId).toBe(view.sessionId)
  createQuestionBankRepository(db).deleteBank(bank.id)
  restarted.startLearning()
  restarted.windowClosed()
  expect(store.load()).toMatchObject({ session: null, nextAt: expect.any(Number) })
  const row = db
    .prepare('SELECT outcome, payload FROM learning_history WHERE session_id = ?')
    .get(view.sessionId)
  expect(row?.outcome).toBe('skipped')
  expect(JSON.parse(String(row?.payload)).answers).toHaveLength(1)
})
