import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PingoApi } from '../../../shared/ipc'
import {
  BANK_LIMITS,
  LANGUAGE_QUESTION_TYPES,
  PRACTICE_SOURCES,
  QUESTION_KINDS,
  REVIEW_SUCCESSES,
} from '../../../shared/question-bank'
import type {
  PracticeSource,
  Question,
  QuestionBank,
  QuestionDraft,
  QuestionPage,
} from '../../../shared/question-bank'
import { useDesktopValue } from '../reminders/useDesktopValue'
import { ActionDialog } from './ActionDialog'
import { QuestionEditor } from './QuestionEditor'
import { requestMessage } from './feedback'

type EditMode = { kind: 'create' } | { kind: 'edit' | 'delete'; question: Question }

export function QuestionList({
  api,
  bank,
  revision,
  source,
}: {
  api: PingoApi
  bank: QuestionBank
  revision: number
  source: PracticeSource
}) {
  const bankId = bank.id
  const [result, setResult] = useState<QuestionPage>()
  const [mode, setMode] = useState<EditMode>()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [removing, setRemoving] = useState(false)
  const [actionError, setActionError] = useState('')
  const isFullBank = source === 'all'
  const { value: reminder } = useDesktopValue(
    isFullBank ? undefined : api.getReminderStatus,
    isFullBank ? undefined : api.onReminderStatus,
  )
  const reviewRevision = reminder?.reviewRevision

  useEffect(() => {
    let active = true
    const timer = setTimeout(
      () => {
        void api
          .queryQuestions({ bankId, query, page, source })
          .then((value) => {
            if (active) {
              setResult(value)
              setError('')
            }
          })
          .catch((cause: unknown) => {
            if (active) {
              setResult(undefined)
              setError(requestMessage(cause))
            }
          })
      },
      query ? 160 : 0,
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, bankId, source, query, page, attempt, revision, reviewRevision])

  const term = query.trim()
  const questions = result?.items
  const pageCount = Math.ceil((result?.total ?? 0) / BANK_LIMITS.pageSize)
  const currentPage = result?.page ?? 0

  async function save(draft: QuestionDraft, previous?: Question) {
    if (previous) {
      await api.updateQuestion({ bankId, questionId: previous.id, question: draft })
    } else {
      await api.createQuestion({ bankId, question: draft })
      setQuery('')
      setPage(term ? 0 : Math.floor((result?.total ?? 0) / BANK_LIMITS.pageSize))
    }
    setAttempt((value) => value + 1)
  }

  async function removeFavorite(questionId: string) {
    setRemoving(true)
    setActionError('')
    try {
      await api.removeBankFavorite({ bankId, questionId })
      setAttempt((value) => value + 1)
    } catch (cause) {
      setActionError(requestMessage(cause))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section className="question-section" aria-labelledby="question-list-heading">
      <div className="question-list-header">
        <div>
          <h2 id="question-list-heading">{isFullBank ? '题目' : PRACTICE_SOURCES[source]}</h2>
          {result && (
            <p className="bank-hint" aria-live="polite">
              {term ? `${result.total} 道匹配题目` : `共 ${result.total} 道题`}
            </p>
          )}
        </div>
        <div className="bank-actions">
          <input
            type="search"
            className="bank-search"
            placeholder="搜索题干"
            aria-label="搜索题干"
            maxLength={BANK_LIMITS.prompt}
            value={query}
            disabled={!result && !query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
          />
          {isFullBank && (
            <button
              className="primary-button button-with-icon"
              type="button"
              disabled={!questions}
              onClick={() => setMode({ kind: 'create' })}
            >
              <Plus size={16} aria-hidden="true" />
              添加题目
            </button>
          )}
        </div>
      </div>
      {actionError && (
        <p className="bank-error" role="alert">
          {actionError}
        </p>
      )}

      {questions?.length ? (
        <>
          <ul className="question-list">
            {questions.map((question) => (
              <li key={question.id} className="question-row">
                <div>
                  <p className="question-prompt">{question.prompt}</p>
                  <span className="bank-hint">
                    {question.languageType
                      ? LANGUAGE_QUESTION_TYPES[question.languageType].label
                      : QUESTION_KINDS[question.kind]}
                    {question.difficulty ? ` · 难度 ${question.difficulty}` : ''}
                  </span>
                  {question.reviewSuccesses !== undefined && (
                    <p className="bank-hint">
                      连续答对 {question.reviewSuccesses} / {REVIEW_SUCCESSES} 次
                    </p>
                  )}
                </div>
                {isFullBank && (
                  <div className="bank-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setMode({ kind: 'edit', question })}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="quiet-danger-button"
                      onClick={() => setMode({ kind: 'delete', question })}
                    >
                      删除
                    </button>
                  </div>
                )}
                {source === 'favorites' && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={removing}
                    onClick={() => void removeFavorite(question.id)}
                  >
                    取消收藏
                  </button>
                )}
              </li>
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="bank-actions question-pagination">
              <button
                className="secondary-button"
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <span className="bank-hint">
                第 {currentPage + 1} / {pageCount} 页
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={currentPage + 1 === pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="bank-list-empty">
          {error ? (
            <>
              <p className="bank-error" role="alert">
                {error}
              </p>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setError('')
                  setAttempt(attempt + 1)
                }}
              >
                重试
              </button>
            </>
          ) : (
            <p role="status">
              {questions
                ? term
                  ? '没有找到匹配的题目。'
                  : isFullBank
                    ? '这个题库还没有题目。'
                    : `这个${PRACTICE_SOURCES[source]}还没有题目。`
                : '正在读取题目…'}
            </p>
          )}
        </div>
      )}

      {mode?.kind === 'delete' ? (
        <ActionDialog
          title="删除题目"
          label="确认删除"
          destructive
          onClose={() => setMode(undefined)}
          onSubmit={async () => {
            await api.deleteQuestion({ bankId, questionId: mode.question.id })
            setPage(currentPage)
            setAttempt((value) => value + 1)
          }}
        >
          <p className="bank-confirm">将永久删除「{mode.question.prompt}」。</p>
        </ActionDialog>
      ) : (
        mode && (
          <QuestionEditor
            template={bank.template}
            question={mode.kind === 'edit' ? mode.question : undefined}
            onSave={(draft) => save(draft, mode.kind === 'edit' ? mode.question : undefined)}
            onClose={() => setMode(undefined)}
          />
        )
      )}
    </section>
  )
}
