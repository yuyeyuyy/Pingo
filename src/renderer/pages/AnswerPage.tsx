import { useState } from 'react'
import type { FormEvent } from 'react'
import type { PingoApi } from '../../shared/ipc'
import { SNOOZE_MINUTES } from '../../shared/reminders'
import type { AnswerView } from '../../shared/reminders'
import { desktopError, useDesktopValue } from '../components/reminders/useDesktopValue'

type QuestionView = Extract<AnswerView, { kind: 'question' }>

function QuestionStep({ api, view }: { api: PingoApi; view: QuestionView }) {
  const { question, feedback, position, total } = view
  const [option, setOption] = useState<number>()
  const [text, setText] = useState('')
  const [minutes, setMinutes] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const target = { sessionId: view.sessionId, questionId: question.id }
  const final = position === total

  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(desktopError(cause))
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (feedback) {
      void run(() => api.advanceAnswer(target))
    } else if (question.kind === 'short-answer') {
      void run(() => api.submitAnswer({ ...target, answer: { kind: 'short-answer', text } }))
    } else if (option !== undefined) {
      void run(() =>
        api.submitAnswer({ ...target, answer: { kind: 'multiple-choice', optionIndex: option } }),
      )
    }
  }

  return (
    <main className="learning-window">
      <header className="learning-header">
        <div>
          <h1>学习练习</h1>
          <p className="bank-hint">{question.bankName}</p>
        </div>
        <span aria-label={`第 ${position} 题，共 ${total} 题`}>
          {position} / {total}
        </span>
      </header>
      <form className="learning-form" onSubmit={submit}>
        <div className="learning-body">
          <h2>{question.prompt}</h2>
          {question.kind === 'multiple-choice' ? (
            <fieldset className="learning-options" disabled={busy || !!feedback}>
              <legend className="bank-hint">请选择一项</legend>
              {question.options.map((label, index) => (
                <label
                  key={index}
                  className="learning-option"
                  data-correct={feedback?.kind === 'multiple-choice' && feedback.correct === index}
                >
                  <input
                    type="radio"
                    name="answer"
                    checked={
                      (feedback?.kind === 'multiple-choice' ? feedback.selected : option) === index
                    }
                    onChange={() => setOption(index)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <label className="bank-field">
              你的答案
              <textarea
                required
                rows={4}
                maxLength={10_000}
                disabled={busy || !!feedback}
                value={feedback?.kind === 'short-answer' ? feedback.text : text}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
          )}
          {feedback && (
            <div className="learning-feedback" role="status">
              {feedback.kind === 'multiple-choice' && question.kind === 'multiple-choice' ? (
                <>
                  <strong>{feedback.outcome === 'correct' ? '回答正确' : '回答错误'}</strong>
                  <p>正确答案：{question.options[feedback.correct]}</p>
                </>
              ) : (
                feedback.kind === 'short-answer' && (
                  <>
                    <strong>已记录，待自评</strong>
                    <p>
                      {feedback.referenceAnswer
                        ? `参考答案：${feedback.referenceAnswer}`
                        : '这道题暂无参考答案。'}
                    </p>
                  </>
                )
              )}
            </div>
          )}
          {error && (
            <p className="bank-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="learning-footer">
          <div className="bank-actions">
            <label className="bank-field">
              <select
                aria-label="稍后提醒时长"
                value={minutes}
                disabled={busy}
                onChange={(event) => setMinutes(Number(event.target.value))}
              >
                {SNOOZE_MINUTES.map((value) => (
                  <option key={value} value={value}>
                    {value === 60 ? '1 小时后' : `${value} 分钟后`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => run(() => api.snoozeLearning({ sessionId: view.sessionId, minutes }))}
            >
              稍后提醒
            </button>
          </div>
          <button
            type="submit"
            className="primary-button"
            disabled={
              busy ||
              (!feedback &&
                (question.kind === 'multiple-choice' ? option === undefined : !text.trim()))
            }
          >
            {feedback ? (final ? '完成学习' : '下一题') : '提交答案'}
          </button>
        </footer>
      </form>
    </main>
  )
}

export function AnswerPage() {
  const api = window.pingo
  const { value, error } = useDesktopValue(api?.getAnswerView, api?.onAnswerView)

  if (value?.kind === 'question' && api) {
    return <QuestionStep key={`${value.sessionId}:${value.position}`} api={api} view={value} />
  }

  return (
    <main className="answer-page">
      {value?.kind === 'summary' ? (
        <>
          <h1>本轮学习已完成</h1>
          <p>共 {value.total} 道题</p>
          <dl className="learning-summary">
            <div>
              <dt>答对</dt>
              <dd>{value.correct}</dd>
            </div>
            <div>
              <dt>答错</dt>
              <dd>{value.incorrect}</dd>
            </div>
            <div>
              <dt>待自评</dt>
              <dd>{value.ungraded}</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <h1>学习练习</h1>
          <p role="status">
            {error || (value === undefined && api ? '正在读取题目…' : '目前没有进行中的练习。')}
          </p>
        </>
      )}
      <button className="secondary-button" type="button" onClick={() => window.close()}>
        关闭窗口
      </button>
    </main>
  )
}
