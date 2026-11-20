import type { PartOfSpeech } from './part-of-speech'

export const BANK_TEMPLATES = {
  basic: '基础模板',
  language: '语言学习模板',
} as const

export type BankTemplate = keyof typeof BANK_TEMPLATES

export const QUESTION_KINDS = {
  'multiple-choice': '选择',
  'short-answer': '填写',
  'fill-in': '填空',
  ordering: '排序',
} as const

export type QuestionKind = keyof typeof QUESTION_KINDS
export type Difficulty = 1 | 2 | 3 | 4 | 5

export const LANGUAGE_QUESTION_TYPES = {
  'word-to-meaning': { label: '单词选释义', kind: 'multiple-choice' },
  'meaning-to-word': { label: '释义选单词', kind: 'multiple-choice' },
  'word-spelling': { label: '单词拼写', kind: 'short-answer' },
  'word-fill-in': { label: '单词填空', kind: 'fill-in' },
  synonym: { label: '近义词', kind: 'multiple-choice' },
  antonym: { label: '反义词', kind: 'multiple-choice' },
  'grammar-choice': { label: '语法选择', kind: 'multiple-choice' },
  'grammar-fill-in': { label: '语法填空', kind: 'fill-in' },
  'grammar-correction': { label: '语法纠错', kind: 'short-answer' },
  'sentence-ordering': { label: '句子排序', kind: 'ordering' },
  'sentence-meaning': { label: '句意理解', kind: 'multiple-choice' },
  'context-word-choice': { label: '语境选词', kind: 'multiple-choice' },
} as const satisfies Record<string, { label: string; kind: QuestionKind }>

export type LanguageQuestionType = keyof typeof LANGUAGE_QUESTION_TYPES
export const BLANK_MARKER = '{{blank}}'

type QuestionContent =
  | {
      readonly kind: 'multiple-choice'
      readonly options: readonly string[]
      readonly correctOptionIndex: number
      readonly optionExplanations?: readonly (string | null)[]
      readonly optionPartsOfSpeech?: readonly (PartOfSpeech | null)[]
    }
  | {
      readonly kind: 'short-answer'
      readonly referenceAnswer?: string
      readonly acceptedAnswers?: readonly string[]
    }
  | { readonly kind: 'fill-in'; readonly blanks: readonly (readonly string[])[] }
  | {
      readonly kind: 'ordering'
      readonly items: readonly string[]
      readonly correctOrder: readonly number[]
    }

export type QuestionDraft = QuestionContent & {
  readonly prompt: string
  readonly languageType?: LanguageQuestionType
  readonly difficulty?: Difficulty
  readonly conceptKey?: string
  readonly materialKey?: string
}

export type Question = QuestionDraft & { readonly id: string }

export interface QuestionBank {
  readonly id: string
  readonly name: string
  readonly template: BankTemplate
}

export function isPermutation(order: readonly unknown[], size: number): order is readonly number[] {
  return (
    order.length === size &&
    new Set(order).size === size &&
    order.every(
      (index) => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < size,
    )
  )
}
