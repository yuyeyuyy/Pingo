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

it('appends to the selected template bank, preserving existing questions and rolling back invalid imports', () => {
  const banks = service()
  const language = banks.createBank({ name: '英文', template: 'language' })
  const basic = banks.createBank({ name: '旧题' })
  const vocabulary = {
    ...choice,
    languageType: 'word-to-meaning',
    optionExplanations: ['zero', null, 'one hundred'],
    optionPartsOfSpeech: ['num', null, 'num'],
  }
  const item = banks.createQuestion({ bankId: language.id, question: written })
  expect(
    banks.appendQuestionImport({
      bankId: language.id,
      json: JSON.stringify({ name: '文件内标题', questions: [vocabulary] }),
    }),
  ).toEqual({ added: 1 })
  expect(banks.listBanks()).toEqual([language, basic])
  expect(banks.listQuestions({ bankId: language.id })).toMatchObject([item, vocabulary])
  expect(() =>
    banks.appendQuestionImport({
      bankId: basic.id,
      json: JSON.stringify({ questions: [vocabulary] }),
    }),
  ).toThrow('需要导入语言学习题库')
  expect(() =>
    banks.appendQuestionImport({
      bankId: language.id,
      json: JSON.stringify({ questions: [written, { ...vocabulary, optionExplanations: ['零'] }] }),
    }),
  ).toThrow('第 2 题')
  expect(banks.listQuestions({ bankId: basic.id })).toEqual([])
  expect(banks.listQuestions({ bankId: language.id })).toHaveLength(2)

  const question = banks.listQuestions({ bankId: language.id })[1]!
  expect(() =>
    banks.updateQuestion({
      bankId: language.id,
      questionId: question.id,
      question: { ...vocabulary, optionPartsOfSpeech: ['num'] },
    }),
  ).toThrow('词性数量')
  expect(() =>
    banks.updateQuestion({
      bankId: language.id,
      questionId: question.id,
      question: { ...vocabulary, optionPartsOfSpeech: ['nounish', null, null] },
    }),
  ).toThrow('词性无效')
  banks.updateQuestion({
    bankId: language.id,
    questionId: question.id,
    question: {
      ...vocabulary,
      optionExplanations: [null, 'ten', null],
      optionPartsOfSpeech: [null, '数词', 'NUM.'],
    },
  })
  expect(banks.listQuestions({ bankId: language.id })[1]).toMatchObject({
    optionExplanations: [null, 'ten', null],
    optionPartsOfSpeech: [null, 'num', 'num'],
  })
})

it('validates and persists the language of a language-template bank', () => {
  const banks = service()
  const english = banks.createBank({ name: '旧调用', template: 'language' })
  const japanese = banks.createBank({ name: '日语题库', template: 'language', language: 'ja' })
  expect(english.language).toBe('en')
  expect(japanese.language).toBe('ja')
  expect(banks.renameBank({ bankId: japanese.id, name: '日语练习' }).language).toBe('ja')
  expect(banks.listBanks()[1]).toMatchObject({ id: japanese.id, language: 'ja' })
  expect(() =>
    banks.createBank({ name: '不支持的代码', template: 'language', language: 'fake' }),
  ).toThrow('有效的题库语言')
  expect(() => banks.createBank({ name: '基础', language: 'en' })).toThrow('语言学习模板')
})

it('accepts more than 3000 questions and searches and paginates within one bank', () => {
  const banks = service()
  const target = banks.createBank({ name: '大量题目' })
  const another = banks.createBank({ name: '其他题库' })
  banks.createQuestion({ bankId: another.id, question: { ...written, prompt: 'Résumé 3100' } })
  const questions = Array.from({ length: 3_101 }, (_, index) => ({
    ...written,
    prompt: `Résumé ${index}`,
  }))
  expect(
    banks.appendQuestionImport({ bankId: target.id, json: JSON.stringify({ questions }) }),
  ).toEqual({ added: 3_101 })
  const last = banks.queryQuestions({ bankId: target.id, query: ' RÉSUMÉ ', page: 999 })
  expect(last).toMatchObject({ total: 3_101, page: 62 })
  expect(last.items.map((question) => question.prompt)).toEqual(['Résumé 3100'])
  expect(banks.queryQuestions({ bankId: target.id, query: 'Résumé 3100', page: 0 }).total).toBe(1)
})

it('rolls back an append when SQLite rejects a row after an earlier row succeeded', () => {
  const banks = service()
  const target = banks.createBank({ name: '事务题库' })
  const existing = banks.createQuestion({ bankId: target.id, question: written })
  const ids = [randomUUID(), existing.id]
  const appending = service(() => ids.shift() as ReturnType<typeof randomUUID>)
  expect(() =>
    appending.appendQuestionImport({
      bankId: target.id,
      json: JSON.stringify({ questions: [choice, written] }),
    }),
  ).toThrow(/UNIQUE constraint/)
  expect(banks.listQuestions({ bankId: target.id })).toEqual([existing])
})
