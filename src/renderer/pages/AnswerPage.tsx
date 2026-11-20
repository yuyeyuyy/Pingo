import { Star } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { PingoApi } from '../../shared/ipc'
import { LANGUAGE_QUESTION_TYPES } from '../../shared/question-bank'
import { SNOOZE_MINUTES } from '../../shared/reminders'
import type { AnswerView } from '../../shared/reminders'
import { desktopError, useDesktopValue } from '../components/reminders/useDesktopValue'
import {
  AnswerFields,
  FeedbackNote,
  initialAnswer,
  readyToSubmit,
} from '../components/reminders/AnswerFields'

type QuestionView = Extract<AnswerView, { kind: 'question' }>

function useStepAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
  return { busy, error, run }
}

function SnoozeControls({ busy, onSnooze }: { busy: boolean; onSnooze(minutes: number): void }) {
  const [minutes, setMinutes] = useState(10)
  return (
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
        onClick={() => onSnooze(minutes)}
      >
        稍后提醒
      </button>
    </div>
  )
}

function MaterialStep({
  api,
  view,
}: {
  api: PingoApi
  view: Extract<AnswerView, { kind: 'material' }>
}) {
  const { sessionId, position, total, material } = view
  const { busy, error, run } = useStepAction()
  return (
    <main className="learning-window">
      <header className="learning-header">
        <div>
          <h1>学习资料</h1>
          <p className="bank-hint">{material.bankName}</p>
        </div>
        <div className="learning-header-actions">
          <span aria-label={`第 ${position} 份，共 ${total} 份资料`}>
            {position} / {total}
          </span>
        </div>
      </header>
      <div className="learning-form">
        <section className="learning-body study-material" aria-labelledby="material-title">
          <h2 id="material-title">{material.title}</h2>
          <p>{material.explanation}</p>
          {material.examples.length > 0 && (
            <div className="study-material-examples">
              <h3>示例</h3>
              <ul>
                {material.examples.map(({ text, translation }, index) => (
                  <li className="learning-feedback" key={index}>
                    <p>{text}</p>
                    {translation && <p className="bank-hint">{translation}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p className="bank-error" role="alert">
              {error}
            </p>
          )}
        </section>
        <footer className="learning-footer">
          <SnoozeControls
            busy={busy}
            onSnooze={(minutes) => run(() => api.snoozeLearning({ sessionId, minutes }))}
          />
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => run(() => api.advanceStudyMaterial({ sessionId, position }))}
          >
            {position === total ? '开始练习' : '下一份资料'}
          </button>
        </footer>
      </div>
    </main>
  )
}

function QuestionStep({ api, view }: { api: PingoApi; view: QuestionView }) {
  const { question, feedback, position, total } = view
  const [answer, setAnswer] = useState(() => initialAnswer(question))
  const { busy, error, run } = useStepAction()
  const target = { sessionId: view.sessionId, questionId: question.id }
  const final = position === total

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (feedback) void run(() => api.advanceAnswer(target))
    else if (readyToSubmit(answer)) void run(() => api.submitAnswer({ ...target, answer }))
  }

  return (
    <main className="learning-window">
      <header className="learning-header">
        <div>
          <h1>学习练习</h1>
          <p className="bank-hint">
            {question.bankName}
            {question.languageType && ` · ${LANGUAGE_QUESTION_TYPES[question.languageType].label}`}
          </p>
        </div>
        <div className="learning-header-actions">
          <button
            type="button"
            className="secondary-button button-with-icon"
            aria-pressed={view.favorite}
            disabled={busy}
            onClick={() =>
              run(() => api.setAnswerFavorite({ ...target, favorite: !view.favorite }))
            }
          >
            <Star size={15} fill={view.favorite ? 'currentColor' : 'none'} aria-hidden="true" />
            {view.favorite ? '取消收藏' : '收藏'}
          </button>
          <span aria-label={`第 ${position} 题，共 ${total} 题`}>
            {position} / {total}
          </span>
        </div>
      </header>
      <form className="learning-form" onSubmit={submit}>
        <div className="learning-body">
          <h2>{question.prompt}</h2>
          <AnswerFields
            question={question}
            feedback={feedback}
            answer={answer}
            onAnswer={setAnswer}
            busy={busy}
          />
          {feedback && <FeedbackNote question={question} feedback={feedback} />}
          {feedback?.outcome === 'ungraded' && (
            <div className="bank-actions" aria-label="自评结果">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run(() => api.rateAnswer({ ...target, correct: true }))}
              >
                自评答对
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run(() => api.rateAnswer({ ...target, correct: false }))}
              >
                自评答错
              </button>
            </div>
          )}
          {error && (
            <p className="bank-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="learning-footer">
          <SnoozeControls
            busy={busy}
            onSnooze={(minutes) =>
              run(() => api.snoozeLearning({ sessionId: view.sessionId, minutes }))
            }
          />
          <div className="bank-actions">
            {!feedback && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  run(() => api.submitAnswer({ ...target, answer: { kind: 'unsure' } }))
                }
              >
                不清楚
              </button>
            )}
            <button
              type="submit"
              className="primary-button"
              disabled={busy || (!feedback && !readyToSubmit(answer))}
            >
              {feedback ? (final ? '完成学习' : '下一题') : '提交答案'}
            </button>
          </div>
        </footer>
      </form>
    </main>
  )
}

export function AnswerPage() {
  const api = window.pingo
  const { value, error } = useDesktopValue(api?.getAnswerView, api?.onAnswerView)

  if (value?.kind === 'material' && api) {
    return <MaterialStep key={`${value.sessionId}:${value.position}`} api={api} view={value} />
  }
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
