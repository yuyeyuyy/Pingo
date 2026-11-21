import { BLANK_MARKER, isPermutation } from './question'
import type { LanguageQuestionType, Question } from './question'
import type { PracticeSettings } from './review'
import type { LearningPool, LearningQuestionPlan, LearningStrategy } from './progressive-learning'
import type { SessionStage } from './scheduling'
import type { PartOfSpeech } from './part-of-speech'
import type { StudyMaterial, StudySubject } from './study-material'
import { DEFAULT_BANK_LANGUAGE } from './language'
import type { BankLanguage } from './language'
import { locateSpokenWord, normalizedSpokenWord, supportsPronunciation } from './pronunciation'
import type { PronunciationPreferences, WordRange } from './pronunciation'

export type SessionQuestion = Question & {
  readonly bankName: string
  readonly learning?: LearningQuestionPlan
  readonly language?: BankLanguage
}
export type AnswerInput =
  | { kind: 'unsure' }
  | { kind: 'multiple-choice'; optionIndex: number }
  | { kind: 'short-answer'; text: string }
  | { kind: 'fill-in'; values: readonly string[] }
  | { kind: 'ordering'; order: readonly number[] }

type Outcome = 'correct' | 'incorrect'
export type AnswerFeedback = { unsure?: true } & (
  | {
      kind: 'multiple-choice'
      selected: number | null
      correct: number
      outcome: Outcome
      optionExplanations?: readonly (string | null)[]
      optionPartsOfSpeech?: readonly (PartOfSpeech | null)[]
    }
  | { kind: 'short-answer'; text: string; referenceAnswer?: string; outcome: Outcome | 'ungraded' }
  | { kind: 'fill-in'; values: readonly string[]; expected: readonly string[]; outcome: Outcome }
  | {
      kind: 'ordering'
      selected: readonly number[] | null
      correct: readonly number[]
      outcome: Outcome
    }
)

export interface SubmittedAnswer {
  readonly questionId: string
  readonly feedback: AnswerFeedback
  readonly submittedAt: number
}

export type SessionStudyMaterial = StudyMaterial & {
  readonly bankName: string
  readonly subject?: StudySubject
  readonly language?: BankLanguage
}

export interface StudyMaterialTarget {
  sessionId: string
  position: number
}

export interface LearningSession {
  readonly id: string
  readonly startedAt: number
  readonly stage: SessionStage
  readonly questions: readonly SessionQuestion[]
  readonly index: number
  readonly answers: readonly SubmittedAnswer[]
  readonly practice?: PracticeSettings
  readonly strategy?: LearningStrategy
  readonly study?: {
    readonly materials: readonly SessionStudyMaterial[]
    readonly index: number
    readonly materialsOnly?: true
  }
}

export type VisibleQuestion = {
  id: string
  bankName: string
  prompt: string
  languageType?: LanguageQuestionType
  pool?: LearningPool
} & (
  | {
      kind: 'multiple-choice'
      options: readonly string[]
      pronunciation?: { language: BankLanguage; promptWord?: WordRange }
    }
  | { kind: 'short-answer' }
  | { kind: 'fill-in'; blankCount: number }
  | { kind: 'ordering'; items: readonly string[] }
)

export type PronunciationView = (
  | ({
      kind: 'material'
      total: number
      material: SessionStudyMaterial
      materialsOnly?: true
    } & StudyMaterialTarget)
  | {
      kind: 'question'
      sessionId: string
      position: number
      total: number
      question: VisibleQuestion
      feedback?: AnswerFeedback
      favorite: boolean
    }
) & { pronunciationPreferences?: PronunciationPreferences }

export type AnswerView =
  | PronunciationView
  | ({ kind: 'summary'; sessionId: string; total: number } & (
      | { materialsOnly: true }
      | { materialsOnly?: never; correct: number; incorrect: number; ungraded: number }
    ))
  | null

export interface SessionTarget {
  sessionId: string
  questionId: string
}

export type PronunciationTarget = (SessionTarget & { optionIndex?: number }) | StudyMaterialTarget

export function spokenWord(
  question: VisibleQuestion,
  feedback: AnswerFeedback | undefined,
  optionIndex?: number,
): string | undefined {
  if (question.kind !== 'multiple-choice' || !question.pronunciation) return undefined
  if (question.languageType === 'meaning-to-word' && optionIndex !== undefined)
    return normalizedSpokenWord(question.options[optionIndex])
  if (question.languageType !== 'word-to-meaning') return undefined
  if (optionIndex !== undefined)
    return normalizedSpokenWord(
      feedback?.kind === 'multiple-choice'
        ? (feedback.optionExplanations?.[optionIndex] ?? undefined)
        : undefined,
    )
  const range = question.pronunciation.promptWord
  return range ? normalizedSpokenWord(question.prompt.slice(range.start, range.end)) : undefined
}

export function pronunciationForView(view: PronunciationView, optionIndex?: number) {
  if (view.kind === 'material') {
    const { language, title } = view.material
    const word = normalizedSpokenWord(title)
    return language && supportsPronunciation(language) && word ? { language, word } : undefined
  }
  const { question, feedback } = view
  const word = spokenWord(question, feedback, optionIndex)
  return word && question.kind === 'multiple-choice' && question.pronunciation
    ? { language: question.pronunciation.language, word }
    : undefined
}

export function nextStudyMaterial(session: LearningSession) {
  const study = session.study
  const material = study?.materials[study.index]
  if (!study || !material) return undefined
  // Older session snapshots may carry the language only on their paired question.
  const paired =
    study.materials.length === session.questions.length ? session.questions[study.index] : undefined
  const language =
    material.language ??
    paired?.language ??
    (paired?.languageType ? DEFAULT_BANK_LANGUAGE : undefined)
  return {
    kind: 'material' as const,
    sessionId: session.id,
    position: study.index + 1,
    total: study.materials.length,
    material: language && !material.language ? { ...material, language } : material,
    ...(study.materialsOnly ? { materialsOnly: true as const } : {}),
  }
}

function visibleQuestion(question: SessionQuestion): VisibleQuestion {
  const base = {
    id: question.id,
    bankName: question.bankName,
    prompt: question.prompt,
    languageType: question.languageType,
    ...(question.learning?.pool ? { pool: question.learning.pool } : {}),
  }
  switch (question.kind) {
    case 'multiple-choice': {
      const language = question.language ?? DEFAULT_BANK_LANGUAGE
      const canSpeak =
        supportsPronunciation(language) &&
        (question.languageType === 'word-to-meaning' || question.languageType === 'meaning-to-word')
      const promptWord =
        canSpeak && question.languageType === 'word-to-meaning'
          ? locateSpokenWord(question.prompt, [
              question.headword,
              question.optionExplanations?.[question.correctOptionIndex] ?? undefined,
              question.conceptKey?.split(':', 1)[0],
            ])
          : undefined
      return {
        ...base,
        kind: question.kind,
        options: question.options,
        ...(canSpeak ? { pronunciation: { language, ...(promptWord ? { promptWord } : {}) } } : {}),
      }
    }
    case 'short-answer':
      return { ...base, kind: question.kind }
    case 'fill-in': {
      let index = 0
      return {
        ...base,
        kind: question.kind,
        prompt: base.prompt.replaceAll(BLANK_MARKER, () => `［${++index}］`),
        blankCount: question.blanks.length,
      }
    }
    case 'ordering':
      return { ...base, kind: question.kind, items: question.items }
  }
}

export function questionView(
  session: LearningSession,
  favorite = false,
): Extract<PronunciationView, { kind: 'question' }> | null {
  const question = session.questions[session.index]
  if (!question) return null
  return {
    kind: 'question',
    sessionId: session.id,
    position: session.index + 1,
    total: session.questions.length,
    question: visibleQuestion(question),
    favorite,
    feedback: session.answers[session.index]?.feedback,
  }
}

function normalize(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function matches(text: string, answers: readonly string[], caseSensitive = false): boolean {
  const compare = (value: string) => {
    const normalized = normalize(value)
    return caseSensitive ? normalized : normalized.toLowerCase()
  }
  const submitted = compare(text)
  return answers.some((answer) => compare(answer) === submitted)
}

/** Shuffle the display once; persisted sessions keep the same indexes across restart. */
export function prepareSessionQuestion(
  question: SessionQuestion,
  random: () => number,
): SessionQuestion {
  if (question.kind !== 'ordering') return question
  const positions = question.items.map((_, index) => index)
  for (let index = positions.length - 1; index >= 1; index--) {
    const other = Math.floor(random() * (index + 1))
    const currentPosition = positions[index]!
    positions[index] = positions[other]!
    positions[other] = currentPosition
  }
  if (
    positions.every(
      (index, position) =>
        question.items[index] === question.items[question.correctOrder[position]!],
    )
  ) {
    const different = positions.findIndex(
      (index) => question.items[index] !== question.items[positions[0]!],
    )
    if (different > 0) [positions[0], positions[different]] = [positions[different]!, positions[0]!]
  }
  const newPosition = new Map(positions.map((oldIndex, index) => [oldIndex, index]))
  return {
    ...question,
    items: positions.map((index) => question.items[index]!),
    correctOrder: question.correctOrder.map((index) => newPosition.get(index)!),
  }
}

function unsureFeedback(question: SessionQuestion): AnswerFeedback {
  const base = { unsure: true, outcome: 'incorrect' } as const
  switch (question.kind) {
    case 'multiple-choice':
      return {
        ...base,
        kind: question.kind,
        selected: null,
        correct: question.correctOptionIndex,
        optionExplanations: question.optionExplanations,
        ...(question.optionPartsOfSpeech
          ? { optionPartsOfSpeech: question.optionPartsOfSpeech }
          : {}),
      }
    case 'short-answer':
      return {
        ...base,
        kind: question.kind,
        text: '',
        referenceAnswer: question.referenceAnswer ?? question.acceptedAnswers?.[0],
      }
    case 'fill-in':
      return {
        ...base,
        kind: question.kind,
        values: [],
        expected: question.blanks.map((answers) => answers[0]!),
      }
    case 'ordering':
      return { ...base, kind: question.kind, selected: null, correct: question.correctOrder }
  }
}

export function gradeAnswer(question: SessionQuestion, answer: AnswerInput): AnswerFeedback | null {
  if (answer.kind === 'unsure') return unsureFeedback(question)
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
      ...(question.optionExplanations ? { optionExplanations: question.optionExplanations } : {}),
      ...(question.optionPartsOfSpeech
        ? { optionPartsOfSpeech: question.optionPartsOfSpeech }
        : {}),
    }
  }
  if (question.kind === 'short-answer' && answer.kind === 'short-answer') {
    const text = answer.text.trim()
    if (!text || answer.text.length > 10_000) return null
    const accepted = question.acceptedAnswers
    return {
      kind: question.kind,
      text,
      referenceAnswer: question.referenceAnswer ?? accepted?.[0],
      outcome: accepted
        ? matches(text, accepted, question.languageType === 'grammar-correction')
          ? 'correct'
          : 'incorrect'
        : 'ungraded',
    }
  }
  if (question.kind === 'fill-in' && answer.kind === 'fill-in') {
    const values = answer.values.map((text) => text.trim())
    if (values.length !== question.blanks.length || values.some((text) => !text)) return null
    const correct = question.blanks.every((expected, index) => matches(values[index]!, expected))
    return {
      kind: question.kind,
      values,
      expected: question.blanks.map((expected) => expected[0]!),
      outcome: correct ? 'correct' : 'incorrect',
    }
  }
  if (question.kind === 'ordering' && answer.kind === 'ordering') {
    if (!isPermutation(answer.order, question.items.length)) return null
    // Identical visible tokens may be exchanged without changing the answer.
    const correct = question.correctOrder.every(
      (index, position) => question.items[index] === question.items[answer.order[position]!],
    )
    return {
      kind: question.kind,
      selected: answer.order,
      correct: question.correctOrder,
      outcome: correct ? 'correct' : 'incorrect',
    }
  }
  return null
}

export function sessionSummary(session: LearningSession): Extract<AnswerView, { kind: 'summary' }> {
  if (session.study?.materialsOnly) {
    return {
      kind: 'summary',
      sessionId: session.id,
      total: session.study.materials.length,
      materialsOnly: true,
    }
  }
  const counts = { correct: 0, incorrect: 0, ungraded: 0 }
  for (const answer of session.answers) counts[answer.feedback.outcome]++
  return { kind: 'summary', sessionId: session.id, total: session.questions.length, ...counts }
}
