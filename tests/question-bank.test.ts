import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createQuestionBankService } from '../src/application/question-bank/service'
import { openDatabase } from '../src/infrastructure/database/open'
import { createQuestionBankRepository } from '../src/infrastructure/database/question-bank-repository'

let directory: string
let database: ReturnType<typeof openDatabase>

const choice = {
  kind: 'multiple-choice',
  prompt: '水在标准大气压下的冰点是多少？',
  options: ['0°C', '10°C', '100°C'],
  correctOptionIndex: 0,
}
const written = { kind: 'short-answer', prompt: '解释蒸发。', referenceAnswer: '液体变为气体。' }

function service(newId = randomUUID) {
  return createQuestionBankService(createQuestionBankRepository(database), newId)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pingo-bank-'))
  database = openDatabase(directory)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

it('persists edits and kind changes across connections and scopes questions to their bank', () => {
  const banks = service()
  const first = banks.createBank({ name: '  科学  ' })
  const second = banks.createBank({ name: '语言' })
  expect(first.name).toBe('科学')
  const question = banks.createQuestion({ bankId: first.id, question: choice })
  expect(banks.listQuestions({ bankId: first.id })).toEqual([question])
  expect(() => banks.deleteQuestion({ bankId: second.id, questionId: question.id })).toThrow(
    '题目不存在',
  )

  const renamed = banks.renameBank({ bankId: first.id, name: '自然科学' })
  const updated = banks.updateQuestion({
    bankId: first.id,
    questionId: question.id,
    question: written,
  })
  database.close()
  database = openDatabase(directory)

  const reopened = service()
  expect(reopened.listBanks()).toEqual([renamed, second])
  expect(reopened.listQuestions({ bankId: first.id })).toEqual([updated])
  expect(updated).toEqual({ id: question.id, ...written })
  expect(reopened.listQuestions({ bankId: second.id })).toEqual([])
  reopened.deleteQuestion({ bankId: first.id, questionId: question.id })
  expect(reopened.listQuestions({ bankId: first.id })).toEqual([])
})

it('imports both question types in file order and cascades question deletion with their bank', () => {
  const banks = service()
  const imported = banks.importQuestionBank(
    `\uFEFF${JSON.stringify({ name: '科学', questions: [choice, written] })}`,
  )

  expect(banks.listQuestions({ bankId: imported.id })).toMatchObject([choice, written])
  banks.deleteBank({ bankId: imported.id })
  expect(banks.listBanks()).toEqual([])
  expect(database.prepare('SELECT id FROM questions').all()).toEqual([])
})

it('reports the invalid question index and leaves no partially imported bank', () => {
  const banks = service()
  const invalid = { ...choice, correctOptionIndex: 9 }
  const file = JSON.stringify({ name: '科学', questions: [written, invalid] })
  expect(() => banks.importQuestionBank(file)).toThrow('第 2 题')
  expect(banks.listBanks()).toEqual([])
  expect(database.prepare('SELECT id FROM questions').all()).toEqual([])
})

it('rolls back the bank and earlier rows when a database insert fails mid-import', () => {
  const duplicate = randomUUID()
  const banks = service(() => duplicate)
  const file = JSON.stringify({ name: '科学', questions: [written, choice] })

  expect(() => banks.importQuestionBank(file)).toThrow(/UNIQUE constraint/)
  expect(banks.listBanks()).toEqual([])
  expect(database.prepare('SELECT id FROM questions').all()).toEqual([])
})
