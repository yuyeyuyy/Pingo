export type { Question, QuestionBank, QuestionDraft } from '../domain/question'

export const BANK_LIMITS = {
  name: 120,
  prompt: 10_000,
  referenceAnswer: 10_000,
  option: 2_000,
  minOptions: 2,
  maxOptions: 20,
  importQuestions: 3_000,
  importBytes: 4 * 1024 * 1024,
} as const
