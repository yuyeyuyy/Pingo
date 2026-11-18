export type QuestionDraft =
  | {
      readonly kind: 'multiple-choice'
      readonly prompt: string
      readonly options: readonly string[]
      readonly correctOptionIndex: number
    }
  | {
      readonly kind: 'short-answer'
      readonly prompt: string
      readonly referenceAnswer?: string
    }

export type Question = QuestionDraft & { readonly id: string }

export interface QuestionBank {
  readonly id: string
  readonly name: string
}
