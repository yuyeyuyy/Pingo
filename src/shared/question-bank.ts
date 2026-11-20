export {
  BANK_TEMPLATES,
  BLANK_MARKER,
  LANGUAGE_QUESTION_TYPES,
  QUESTION_KINDS,
} from '../domain/question'
export type {
  BankTemplate,
  Difficulty,
  LanguageQuestionType,
  Question,
  QuestionBank,
  QuestionDraft,
  QuestionKind,
} from '../domain/question'
export { PRACTICE_SOURCES, REVIEW_SUCCESSES } from '../domain/review'
export type { PracticeSource } from '../domain/review'
export type { StudyMaterial } from '../domain/study-material'
export { PARTS_OF_SPEECH } from '../domain/part-of-speech'
export type { PartOfSpeech } from '../domain/part-of-speech'

export type QuestionPageItem = import('../domain/question').Question & { reviewSuccesses?: number }

export const BANK_LIMITS = {
  name: 120,
  prompt: 10_000,
  referenceAnswer: 10_000,
  option: 2_000,
  minOptions: 2,
  maxOptions: 20,
  maxItems: 60,
  maxBlanks: 20,
  conceptKey: 160,
  materialKey: 160,
  materialTitle: 200,
  maxExamples: 5,
  importBytes: 32 * 1024 * 1024,
  pageSize: 50,
} as const

export interface QuestionPage {
  items: readonly QuestionPageItem[]
  total: number
  page: number
}

export interface QuestionImportResult {
  added: number
  materials?: number
}
