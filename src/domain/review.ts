export interface Review {
  readonly questionId: string
  readonly reviewedAt: string
  readonly outcome: 'correct' | 'incorrect' | 'ungraded'
}
