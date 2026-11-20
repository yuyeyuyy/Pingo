import { ArrowDown, ArrowUp } from 'lucide-react'
import type { AnswerView, AnswerInput } from '../../../shared/reminders'
import { BANK_LIMITS, PARTS_OF_SPEECH } from '../../../shared/question-bank'

type View = Extract<AnswerView, { kind: 'question' }>
type Question = View['question']
type Feedback = NonNullable<View['feedback']>

export function initialAnswer(question: Question): AnswerInput | undefined {
  switch (question.kind) {
    case 'fill-in':
      return { kind: question.kind, values: Array.from({ length: question.blankCount }, () => '') }
    case 'ordering':
      return { kind: question.kind, order: question.items.map((_, index) => index) }
    case 'short-answer':
      return { kind: question.kind, text: '' }
    case 'multiple-choice':
      return undefined
  }
}

export function readyToSubmit(answer: AnswerInput | undefined): answer is AnswerInput {
  if (!answer) return false
  if (answer.kind === 'short-answer') return !!answer.text.trim()
  if (answer.kind === 'fill-in') return answer.values.every((value) => !!value.trim())
  return true
}

export function AnswerFields({
  question,
  feedback,
  answer,
  onAnswer,
  busy,
}: {
  question: Question
  feedback?: Feedback
  answer?: AnswerInput
  onAnswer(answer: AnswerInput): void
  busy: boolean
}) {
  const disabled = busy || !!feedback
  switch (question.kind) {
    case 'multiple-choice': {
      const result = feedback?.kind === 'multiple-choice' ? feedback : undefined
      const selected = result
        ? result.selected
        : answer?.kind === 'multiple-choice'
          ? answer.optionIndex
          : undefined
      return (
        <fieldset className="learning-options" disabled={disabled}>
          <legend className="bank-hint">请选择一项</legend>
          {question.options.map((label, index) => {
            const explanation = result?.optionExplanations?.[index]
            const part = result?.optionPartsOfSpeech?.[index]
            return (
              <label
                key={index}
                className="learning-option"
                data-correct={result?.correct === index}
              >
                <input
                  type="radio"
                  name="answer"
                  checked={selected === index}
                  onChange={() => onAnswer({ kind: question.kind, optionIndex: index })}
                />
                <span className="learning-option-label">{label}</span>
                {explanation && (
                  <span className="learning-option-meaning">
                    {part && <abbr title={PARTS_OF_SPEECH[part]}>{part}.</abbr>}
                    <span>{explanation}</span>
                  </span>
                )}
              </label>
            )
          })}
        </fieldset>
      )
    }
    case 'short-answer':
      return (
        <label className="bank-field">
          你的答案
          <textarea
            required
            rows={4}
            maxLength={BANK_LIMITS.referenceAnswer}
            spellCheck={false}
            autoCapitalize="off"
            disabled={disabled}
            value={
              feedback?.kind === 'short-answer'
                ? feedback.text
                : answer?.kind === 'short-answer'
                  ? answer.text
                  : ''
            }
            onChange={(event) => onAnswer({ kind: question.kind, text: event.target.value })}
          />
        </label>
      )
    case 'fill-in': {
      const values =
        feedback?.kind === 'fill-in'
          ? feedback.values
          : answer?.kind === 'fill-in'
            ? answer.values
            : []
      return (
        <div className="learning-blanks">
          {Array.from({ length: question.blankCount }, (_, index) => (
            <label key={index} className="bank-field">
              第 {index + 1} 空
              <input
                type="text"
                required
                maxLength={BANK_LIMITS.option}
                spellCheck={false}
                autoCapitalize="off"
                disabled={disabled}
                value={values[index] ?? ''}
                onChange={(event) =>
                  onAnswer({
                    kind: question.kind,
                    values: values.map((value, position) =>
                      position === index ? event.target.value : value,
                    ),
                  })
                }
              />
            </label>
          ))}
        </div>
      )
    }
    case 'ordering': {
      const order =
        feedback?.kind === 'ordering'
          ? (feedback.selected ?? question.items.map((_, index) => index))
          : answer?.kind === 'ordering'
            ? answer.order
            : []
      function move(from: number, to: number) {
        const next = [...order]
        const item = next[from]
        if (item === undefined || next[to] === undefined) return
        next[from] = next[to]
        next[to] = item
        onAnswer({ kind: 'ordering', order: next })
      }
      return (
        <div>
          <p className="bank-hint">用上下箭头调整条目顺序。</p>
          <ol className="learning-order">
            {order.map((index, position) => (
              <li key={index}>
                <span className="learning-order-position" aria-hidden="true">
                  {position + 1}
                </span>
                <span className="learning-order-token">{question.items[index]}</span>
                <div className="bank-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`上移第 ${position + 1} 项`}
                    disabled={disabled || position === 0}
                    onClick={() => move(position, position - 1)}
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`下移第 ${position + 1} 项`}
                    disabled={disabled || position === order.length - 1}
                    onClick={() => move(position, position + 1)}
                  >
                    <ArrowDown size={16} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )
    }
  }
}

export function FeedbackNote({ question, feedback }: { question: Question; feedback: Feedback }) {
  const label = feedback.unsure
    ? '已标记为不清楚'
    : { correct: '回答正确', incorrect: '回答错误', ungraded: '已记录，待自评' }[feedback.outcome]
  return (
    <div className="learning-feedback" role="status">
      <strong>{label}</strong>
      {feedback.kind === 'multiple-choice' && question.kind === 'multiple-choice' && (
        <p>正确答案：{question.options[feedback.correct]}</p>
      )}
      {feedback.kind === 'short-answer' && (
        <p>
          {feedback.referenceAnswer
            ? `参考答案：${feedback.referenceAnswer}`
            : '这道题暂无参考答案。'}
        </p>
      )}
      {feedback.kind === 'fill-in' && (
        <p>
          参考答案：{feedback.expected.map((value, index) => `［${index + 1}］${value}`).join('；')}
        </p>
      )}
      {feedback.kind === 'ordering' && question.kind === 'ordering' && (
        <p>正确顺序：{feedback.correct.map((index) => question.items[index]).join(' → ')}</p>
      )}
    </div>
  )
}
