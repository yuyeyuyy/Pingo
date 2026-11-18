import type { Question, QuestionBank } from '../../domain/question'
import {
  bankName,
  id,
  object,
  parseBankImport,
  questionDraft,
  QuestionBankError,
} from './validation'

export interface QuestionBankRepository {
  listBanks(): readonly QuestionBank[]
  createBank(bank: QuestionBank, questions: readonly Question[]): void
  renameBank(bank: QuestionBank): boolean
  deleteBank(bankId: string): boolean
  listQuestions(bankId: string): readonly Question[] | undefined
  createQuestion(bankId: string, question: Question): boolean
  updateQuestion(bankId: string, question: Question): boolean
  deleteQuestion(bankId: string, questionId: string): boolean
}

function missing(record: '题库' | '题目'): never {
  throw new QuestionBankError('NOT_FOUND', `${record}不存在或已被删除。`)
}

export function createQuestionBankService(repository: QuestionBankRepository, newId: () => string) {
  return {
    listBanks: () => repository.listBanks(),

    createBank(input: unknown): QuestionBank {
      const bank = { id: newId(), name: bankName(object(input).name) }
      repository.createBank(bank, [])
      return bank
    },

    renameBank(input: unknown): QuestionBank {
      const { bankId, name } = object(input)
      const bank = { id: id(bankId), name: bankName(name) }
      if (!repository.renameBank(bank)) missing('题库')
      return bank
    },

    deleteBank(input: unknown): void {
      if (!repository.deleteBank(id(object(input).bankId))) missing('题库')
    },

    listQuestions(input: unknown): readonly Question[] {
      return repository.listQuestions(id(object(input).bankId)) ?? missing('题库')
    },

    createQuestion(input: unknown): Question {
      const { bankId, question } = object(input)
      const created = { ...questionDraft(question), id: newId() }
      if (!repository.createQuestion(id(bankId), created)) missing('题库')
      return created
    },

    updateQuestion(input: unknown): Question {
      const { bankId, questionId, question } = object(input)
      const updated = { ...questionDraft(question), id: id(questionId) }
      if (!repository.updateQuestion(id(bankId), updated)) missing('题目')
      return updated
    },

    deleteQuestion(input: unknown): void {
      const { bankId, questionId } = object(input)
      if (!repository.deleteQuestion(id(bankId), id(questionId))) missing('题目')
    },

    importQuestionBank(json: unknown): QuestionBank {
      const { name, questions } = parseBankImport(json)
      const bank = { id: newId(), name }
      repository.createBank(
        bank,
        questions.map((question) => ({ ...question, id: newId() })),
      )
      return bank
    },
  }
}

export type QuestionBankService = ReturnType<typeof createQuestionBankService>
