import { expect, it } from 'vitest'
import { questionDraft } from '../src/application/question-bank/validation'
import { submitRequest } from '../src/application/reminders/validation'
import { LANGUAGE_QUESTION_TYPES } from '../src/domain/question'
import type { QuestionKind } from '../src/domain/question'
import {
  gradeAnswer,
  prepareSessionQuestion,
  questionView,
  spokenWord,
} from '../src/domain/session'
import type { LearningSession, SessionQuestion } from '../src/domain/session'

const samples = {
  'multiple-choice': {
    kind: 'multiple-choice',
    prompt: 'Apple 的中文释义？',
    options: ['苹果', '梨'],
    correctOptionIndex: 0,
    optionExplanations: ['apple', 'pear'],
  },
  'short-answer': { kind: 'short-answer', prompt: '写出苹果的英文。', acceptedAnswers: ['apple'] },
  'fill-in': {
    kind: 'fill-in',
    prompt: 'She {{blank}} a teacher, and I {{blank}} a student.',
    blanks: [['is'], ['am']],
  },
  ordering: {
    kind: 'ordering',
    prompt: '重新排序。',
    items: ['like', 'I', 'that', 'I'],
    correctOrder: [1, 0, 3, 2],
  },
} as const satisfies Record<QuestionKind, Record<string, unknown>>

const base = { id: 'question', bankName: '语言' }
function view(question: SessionQuestion, answer?: NonNullable<ReturnType<typeof gradeAnswer>>) {
  const session: LearningSession = {
    id: 'session',
    startedAt: 0,
    stage: 'active',
    index: 0,
    questions: [question],
    answers: answer ? [{ questionId: question.id, feedback: answer, submittedAt: 1 }] : [],
  }
  return questionView(session)
}

it.each(Object.entries(LANGUAGE_QUESTION_TYPES))(
  'uses the correct interactive form for %s',
  (languageType, { kind }) => {
    const source = { ...samples[kind], languageType }
    expect(questionDraft(source, 'language')).toMatchObject({ kind, languageType })
    expect(() => questionDraft(source, 'basic')).toThrow('语言学习题库')
    expect(() => questionDraft({ ...source, kind: 'invalid' }, 'language')).toThrow('不匹配')
  },
)

it('reveals distractor meanings and parts of speech only after answering', () => {
  const question: SessionQuestion = {
    ...base,
    ...samples['multiple-choice'],
    languageType: 'word-to-meaning',
    optionPartsOfSpeech: ['n', null],
  }
  const before = view(question)
  expect(before).toMatchObject({ kind: 'question', question: { options: ['苹果', '梨'] } })
  expect(JSON.stringify(before)).not.toContain('pear')
  expect(JSON.stringify(before)).not.toContain('correctOptionIndex')
  expect(JSON.stringify(before)).not.toContain('optionPartsOfSpeech')
  const feedback = gradeAnswer(question, { kind: 'multiple-choice', optionIndex: 0 })
  expect(feedback).toMatchObject({
    outcome: 'correct',
    optionExplanations: ['apple', 'pear'],
    optionPartsOfSpeech: ['n', null],
  })
  expect(gradeAnswer(question, { kind: 'unsure' })).toMatchObject({
    optionPartsOfSpeech: ['n', null],
  })
})

it('reads only the visible headword before submission and revealed words afterwards', () => {
  const question: SessionQuestion = {
    ...base,
    ...samples['multiple-choice'],
    languageType: 'word-to-meaning',
    prompt: 'What does Apple mean?',
    headword: 'apple',
  }
  const initial = view(question)
  if (initial?.kind !== 'question') throw new Error('expected a question')
  expect(spokenWord(initial.question, undefined)).toBe('apple')
  expect(spokenWord(initial.question, undefined, 1)).toBeUndefined()
  const feedback = gradeAnswer(question, { kind: 'multiple-choice', optionIndex: 0 })!
  expect(spokenWord(initial.question, feedback, 1)).toBe('pear')
  const reverse = view({ ...question, languageType: 'meaning-to-word', options: ['apple', 'pear'] })
  if (reverse?.kind !== 'question') throw new Error('expected a question')
  expect(spokenWord(reverse.question, undefined, 0)).toBe('apple')
  expect(spokenWord(reverse.question, undefined)).toBeUndefined()
  const unsupported = view({ ...question, language: 'ja' })
  if (unsupported?.kind !== 'question') throw new Error('expected a question')
  expect(spokenWord(unsupported.question, feedback)).toBeUndefined()
  expect(() => questionDraft({ ...question, headword: 'unrelated' }, 'language')).toThrow(
    '须出现在题干中',
  )
})

it('grades accepted typed answers and keeps legacy self-assessment', () => {
  expect(
    gradeAnswer(
      { ...base, ...samples['short-answer'] },
      { kind: 'short-answer', text: ' ＡＰＰＬＥ ' },
    ),
  ).toMatchObject({ outcome: 'correct' })
  expect(
    gradeAnswer(
      { ...base, kind: 'short-answer', prompt: '旧题', referenceAnswer: '答案' },
      { kind: 'short-answer', text: '答案' },
    ),
  ).toMatchObject({ outcome: 'ungraded' })
})

it('checks capitalization when grading grammar correction', () => {
  const question: SessionQuestion = {
    ...base,
    kind: 'short-answer',
    prompt: '改正 i am here. 的大小写。',
    languageType: 'grammar-correction',
    acceptedAnswers: ['I am here.'],
  }
  expect(gradeAnswer(question, { kind: 'short-answer', text: 'i am here.' })).toMatchObject({
    outcome: 'incorrect',
  })
  expect(gradeAnswer(question, { kind: 'short-answer', text: ' I am here. ' })).toMatchObject({
    outcome: 'correct',
  })
})

it('validates marker count, blank indexes, and answers', () => {
  const question = { ...base, ...samples['fill-in'] }
  const preview = view(question)
  expect(preview).toMatchObject({
    question: { blankCount: 2, prompt: 'She ［1］ a teacher, and I ［2］ a student.' },
  })
  expect(JSON.stringify(preview)).not.toContain('"blanks"')
  expect(() => questionDraft({ ...question, blanks: [['is']] })).toThrow('空格数量')
  expect(gradeAnswer(question, { kind: 'fill-in', values: ['is'] })).toBeNull()
  expect(gradeAnswer(question, { kind: 'fill-in', values: [' Is ', 'AM'] })).toMatchObject({
    outcome: 'correct',
  })
  expect(gradeAnswer(question, { kind: 'fill-in', values: ['is', 'are'] })).toMatchObject({
    outcome: 'incorrect',
  })
})

it('shuffles displayed ordering, validates permutations, and accepts swaps of identical tokens', () => {
  const question = { ...base, ...samples.ordering }
  expect(() => questionDraft({ ...question, correctOrder: [0, 0, 1, 2] })).toThrow('下标')
  expect(gradeAnswer(question, { kind: 'ordering', order: [3, 0, 1, 2] })).toMatchObject({
    outcome: 'correct',
  })
  expect(gradeAnswer(question, { kind: 'ordering', order: [1, 0, 1, 2] })).toBeNull()
  const shuffled = prepareSessionQuestion(question, () => 0.999) as Extract<
    SessionQuestion,
    { kind: 'ordering' }
  >
  expect(
    gradeAnswer(shuffled, { kind: 'ordering', order: shuffled.items.map((_, index) => index) }),
  ).toMatchObject({ outcome: 'incorrect' })
  expect(gradeAnswer(shuffled, { kind: 'ordering', order: shuffled.correctOrder })).toMatchObject({
    outcome: 'correct',
  })
  expect(JSON.stringify(view(shuffled))).not.toContain('correctOrder')
  expect(() =>
    submitRequest({
      sessionId: 's',
      questionId: 'q',
      answer: { kind: 'ordering', order: [0, -1] },
    }),
  ).toThrow('下标无效')
})
