import type { Question, QuestionBank } from '../../domain/question'
import type { PracticeSource } from '../../domain/review'
import type { StudyMaterial } from '../../domain/study-material'
import type { QuestionPage } from '../../shared/question-bank'
import {
  bankName,
  bankLanguage,
  bankTemplate,
  id,
  object,
  parseBankAppend,
  parseBankImport,
  questionDraft,
  questionPage,
  QuestionBankError,
} from './validation'

export interface QuestionBankRepository {
  listBanks(): readonly QuestionBank[]
  getBank(bankId: string): QuestionBank | undefined
  createBank(
    bank: QuestionBank,
    questions: readonly Question[],
    materials?: readonly StudyMaterial[],
  ): void
  appendQuestions(
    bankId: string,
    questions: readonly Question[],
    materials?: readonly StudyMaterial[],
  ): boolean
  renameBank(bank: QuestionBank): boolean
  deleteBank(bankId: string): boolean
  listQuestions(bankId: string): readonly Question[] | undefined
  queryQuestions(
    bankId: string,
    query: string,
    page: number,
    source: PracticeSource,
  ): QuestionPage | undefined
  removeFavorite(bankId: string, questionId: string): void
  createQuestion(bankId: string, question: Question): boolean
  updateQuestion(bankId: string, question: Question): boolean
  deleteQuestion(bankId: string, questionId: string): boolean
}

function missing(record: '题库' | '题目'): never {
  throw new QuestionBankError('NOT_FOUND', `${record}不存在或已被删除。`)
}

export function createQuestionBankService(repository: QuestionBankRepository, newId: () => string) {
  const requireBank = (value: unknown) => repository.getBank(id(value)) ?? missing('题库')

  return {
    listBanks: () => repository.listBanks(),

    createBank(input: unknown): QuestionBank {
      const inputData = object(input)
      const template = bankTemplate(inputData.template)
      const language = bankLanguage(template, inputData.language)
      const bank = {
        id: newId(),
        name: bankName(inputData.name),
        template,
        ...(language ? { language } : {}),
      }
      repository.createBank(bank, [])
      return bank
    },

    renameBank(input: unknown): QuestionBank {
      const { bankId, name } = object(input)
      const bank = { ...requireBank(bankId), name: bankName(name) }
      if (!repository.renameBank(bank)) missing('题库')
      return bank
    },

    deleteBank(input: unknown): void {
      if (!repository.deleteBank(id(object(input).bankId))) missing('题库')
    },

    listQuestions(input: unknown): readonly Question[] {
      return repository.listQuestions(id(object(input).bankId)) ?? missing('题库')
    },

    queryQuestions(input: unknown): QuestionPage {
      const { bankId, query, page, source } = questionPage(input)
      return repository.queryQuestions(bankId, query, page, source) ?? missing('题库')
    },

    removeFavorite(input: unknown): void {
      const { bankId, questionId } = object(input)
      repository.removeFavorite(id(bankId), id(questionId))
    },

    createQuestion(input: unknown): Question {
      const { bankId, question } = object(input)
      const bank = requireBank(bankId)
      const created = { ...questionDraft(question, bank.template), id: newId() }
      if (!repository.createQuestion(bank.id, created)) missing('题库')
      return created
    },

    updateQuestion(input: unknown): Question {
      const { bankId, questionId, question } = object(input)
      const bank = requireBank(bankId)
      const updated = { ...questionDraft(question, bank.template), id: id(questionId) }
      if (!repository.updateQuestion(bank.id, updated)) missing('题目')
      return updated
    },

    deleteQuestion(input: unknown): void {
      const { bankId, questionId } = object(input)
      if (!repository.deleteQuestion(id(bankId), id(questionId))) missing('题目')
    },

    importQuestionBank(json: unknown): QuestionBank {
      const { name, questions, materials } = parseBankImport(json)
      const bank: QuestionBank = { id: newId(), name, template: 'basic' }
      repository.createBank(
        bank,
        questions.map((question) => ({ ...question, id: newId() })),
        materials,
      )
      return bank
    },

    appendQuestionImport(input: unknown) {
      const { bankId, json } = object(input)
      const bank = requireBank(bankId)
      const { questions, materials } = parseBankAppend(json, bank.template)
      if (
        !repository.appendQuestions(
          bank.id,
          questions.map((question) => ({ ...question, id: newId() })),
          materials,
        )
      ) {
        missing('题库')
      }
      return {
        added: questions.length,
        ...(materials.length ? { materials: materials.length } : {}),
      }
    },
  }
}

export type QuestionBankService = ReturnType<typeof createQuestionBankService>
