export interface StudyExample {
  readonly text: string
  readonly translation?: string
}

export interface StudyMaterial {
  readonly key: string
  readonly title: string
  readonly explanation: string
  readonly examples: readonly StudyExample[]
}

export interface StudySubject {
  readonly bankId: string
  readonly key: string
}
