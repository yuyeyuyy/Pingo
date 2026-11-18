import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

it('migrates an existing question database and keeps its banks and questions', () => {
  const banks = createQuestionBankService(createQuestionBankRepository(db), randomUUID)
  const bank = banks.importQuestionBank(
    JSON.stringify({
      name: '科学',
      questions: [{ kind: 'short-answer', prompt: '解释蒸发。' }],
    }),
  )
  db.exec('DROP TABLE learning_history; DROP TABLE reminder_state; PRAGMA user_version = 2')
  db.close()
  db = openDatabase(directory)
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
  expect(createReminderStore(db).load()).toBeUndefined()
  expect(createLearningQuestionSource(db)(20)).toMatchObject([
    { bankName: '科学', prompt: '解释蒸发。' },
  ])
  expect(createQuestionBankRepository(db).listBanks()).toEqual([bank])
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
