import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PingoApi } from '../../../shared/ipc'
import type { Question, QuestionDraft } from '../../../shared/question-bank'
import { ActionDialog } from './ActionDialog'
import { QuestionEditor } from './QuestionEditor'
import { requestMessage } from './feedback'

type EditMode = { kind: 'create' } | { kind: 'edit' | 'delete'; question: Question }
const PAGE_SIZE = 50

export function QuestionList({ api, bankId }: { api: PingoApi; bankId: string }) {
  const [questions, setQuestions] = useState<readonly Question[]>()
  const [mode, setMode] = useState<EditMode>()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    void api
      .listQuestions({ bankId })
      .then((value) => {
        if (active) setQuestions(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(requestMessage(cause))
      })
    return () => {
      active = false
    }
  }, [api, bankId, attempt])

  const term = query.trim().toLowerCase()
  const filtered = questions?.filter((question) => question.prompt.toLowerCase().includes(term))
  const pageCount = Math.ceil((filtered?.length ?? 0) / PAGE_SIZE)
  const currentPage = Math.min(page, Math.max(pageCount - 1, 0))

  async function save(draft: QuestionDraft, previous?: Question) {
    if (previous) {
      const updated = await api.updateQuestion({ bankId, questionId: previous.id, question: draft })
      setQuestions((items) => items?.map((item) => (item.id === updated.id ? updated : item)))
    } else {
      const created = await api.createQuestion({ bankId, question: draft })
      setQuestions((items) => [...(items ?? []), created])
      setQuery('')
      setPage(Math.floor((questions?.length ?? 0) / PAGE_SIZE))
    }
  }

  return (
    <section className="question-section" aria-labelledby="question-list-heading">
      <div className="question-list-header">
        <div>
          <h2 id="question-list-heading">题目</h2>
          {questions && (
            <p className="bank-hint" aria-live="polite">
              {term ? `${filtered?.length} 道匹配题目` : `共 ${questions.length} 道题`}
            </p>
          )}
        </div>
        <div className="bank-actions">
          <input
            type="search"
            className="bank-search"
            placeholder="搜索题干"
            aria-label="搜索题干"
            value={query}
            disabled={!questions?.length}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
          />
          <button
            className="primary-button button-with-icon"
            type="button"
            disabled={!questions}
            onClick={() => setMode({ kind: 'create' })}
          >
            <Plus size={16} aria-hidden="true" />
            添加题目
          </button>
        </div>
      </div>

      {filtered?.length ? (
        <>
          <ul className="question-list">
            {filtered
              .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
              .map((question) => (
                <li key={question.id} className="question-row">
                  <div>
                    <p className="question-prompt">{question.prompt}</p>
                    <span className="bank-hint">
                      {question.kind === 'multiple-choice' ? '选择题' : '简答题'}
                    </span>
                  </div>
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
                  : '这个题库还没有题目。'
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
            setQuestions((items) => items?.filter((item) => item.id !== mode.question.id))
          }}
        >
          <p className="bank-confirm">将永久删除「{mode.question.prompt}」。</p>
        </ActionDialog>
      ) : (
        mode && (
          <QuestionEditor
            question={mode.kind === 'edit' ? mode.question : undefined}
            onSave={(draft) => save(draft, mode.kind === 'edit' ? mode.question : undefined)}
            onClose={() => setMode(undefined)}
          />
        )
      )}
    </section>
  )
}
