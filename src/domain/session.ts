import type { Question } from './question'
import type { SessionStage } from './scheduling'

export type SessionQuestion = Question & { readonly bankName: string }
export type AnswerInput =
  | { kind: 'multiple-choice'; optionIndex: number }
  | { kind: 'short-answer'; text: string }

export type AnswerFeedback =
  | { kind: 'multiple-choice'; selected: number; correct: number; outcome: 'correct' | 'incorrect' }
  | { kind: 'short-answer'; text: string; referenceAnswer?: string; outcome: 'ungraded' }

export interface SubmittedAnswer {
  readonly questionId: string
  readonly feedback: AnswerFeedback
  readonly submittedAt: number
}

export interface LearningSession {
  readonly id: string
  readonly startedAt: number
  readonly stage: SessionStage
  readonly questions: readonly SessionQuestion[]
  readonly index: number
  readonly answers: readonly SubmittedAnswer[]
}

export type VisibleQuestion =
  | {
      id: string
      bankName: string
      prompt: string
      kind: 'multiple-choice'
      options: readonly string[]
    }
  | { id: string; bankName: string; prompt: string; kind: 'short-answer' }

export type AnswerView =
  | {
      kind: 'question'
      sessionId: string
      position: number
      total: number
      question: VisibleQuestion
      feedback?: AnswerFeedback
    }
  | {
      kind: 'summary'
      sessionId: string
      total: number
      correct: number
      incorrect: number
      ungraded: number
    }
  | null

export interface SessionTarget {
  sessionId: string
  questionId: string
}

export function questionView(session: LearningSession): AnswerView {
  const question = session.questions[session.index]
  if (!question) return null
  const base = {
    id: question.id,
    bankName: question.bankName,
    prompt: question.prompt,
  }
  return {
    kind: 'question',
    sessionId: session.id,
    position: session.index + 1,
    total: session.questions.length,
    question:
      question.kind === 'multiple-choice'
        ? { ...base, kind: question.kind, options: question.options }
        : { ...base, kind: question.kind },
    feedback: session.answers[session.index]?.feedback,
  }
}

export function gradeAnswer(question: SessionQuestion, answer: AnswerInput): AnswerFeedback | null {
  if (question.kind === 'multiple-choice' && answer.kind === 'multiple-choice') {
    if (
      !Number.isInteger(answer.optionIndex) ||
      answer.optionIndex < 0 ||
      answer.optionIndex >= question.options.length
    )
      return null
    return {
      kind: question.kind,
      selected: answer.optionIndex,
      correct: question.correctOptionIndex,
      outcome: answer.optionIndex === question.correctOptionIndex ? 'correct' : 'incorrect',
    }
  }
  if (
    question.kind === 'short-answer' &&
    answer.kind === 'short-answer' &&
    answer.text.trim() &&
    answer.text.length <= 10_000
  ) {
    return {
      kind: question.kind,
      text: answer.text.trim(),
      referenceAnswer: question.referenceAnswer,
      outcome: 'ungraded',
    }
  }
  return null
}

export function sessionSummary(session: LearningSession): Extract<AnswerView, { kind: 'summary' }> {
  const counts = { correct: 0, incorrect: 0, ungraded: 0 }
  for (const answer of session.answers) counts[answer.feedback.outcome]++
  return { kind: 'summary', sessionId: session.id, total: session.questions.length, ...counts }
}
