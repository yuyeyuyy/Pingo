import { ArrowLeft, ArrowUpRight, BookOpen, FileUp, Languages, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DragEvent } from 'react'
import type { PingoApi } from '../../shared/ipc'
import { BANK_LIMITS, BANK_TEMPLATES, PRACTICE_SOURCES } from '../../shared/question-bank'
import type { BankTemplate, PracticeSource, QuestionBank } from '../../shared/question-bank'
import { EmptyState } from '../components/EmptyState'
import { ActionDialog } from '../components/question-bank/ActionDialog'
import { BankImportDialog } from '../components/question-bank/BankImportDialog'
import { QuestionEditor } from '../components/question-bank/QuestionEditor'
import { QuestionList } from '../components/question-bank/QuestionList'
import { requestMessage } from '../components/question-bank/feedback'

const templates = [
  { id: 'basic', icon: BookOpen, description: '选择、填写、填空和排序' },
  { id: 'language', icon: Languages, description: '词汇、拼写、语法和句子练习' },
] as const
const bookSources = Object.keys(PRACTICE_SOURCES) as PracticeSource[]

type Mode =
  | { kind: 'create' }
  | { kind: 'rename' | 'delete' | 'add'; bank: QuestionBank }
  | { kind: 'import'; bank: QuestionBank; files: readonly File[] }

function BankNameDialog({
  bank,
  onSave,
  onClose,
}: {
  bank?: QuestionBank
  onSave(name: string, template: BankTemplate): Promise<void>
  onClose(): void
}) {
  const [name, setName] = useState(bank?.name ?? '')
  const [template, setTemplate] = useState(bank?.template)
  return (
    <ActionDialog
      title={bank ? '重命名题库' : '新建题库'}
      label={bank ? '保存名称' : '创建题库'}
      onSubmit={() => {
        if (!template) throw new Error('请选择题库模板。')
        return onSave(name, template)
      }}
      onClose={onClose}
    >
      <label className="bank-field">
        题库名称
        <input
          type="text"
          required
          maxLength={BANK_LIMITS.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {!bank && (
        <fieldset className="bank-template-picker">
          <legend>题库模板</legend>
          {templates.map(({ id, icon: Icon, description }) => (
            <label className="bank-template-option" key={id}>
              <input
                type="radio"
                name="bank-template"
                required
                checked={template === id}
                onChange={() => setTemplate(id)}
              />
              <Icon size={18} aria-hidden="true" />
              <span>
                <strong>{BANK_TEMPLATES[id]}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </ActionDialog>
  )
}

function BankCard({
  bank,
  onOpen,
  onAction,
}: {
  bank: QuestionBank
  onOpen(source: PracticeSource): void
  onAction(mode: Mode): void
}) {
  const [dragging, setDragging] = useState(false)
  const Icon = bank.template === 'language' ? Languages : BookOpen
  function drop(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
    if (event.dataTransfer.files.length)
      onAction({ kind: 'import', bank, files: Array.from(event.dataTransfer.files) })
  }

  return (
    <article
      className="bank-card"
      data-dragging={dragging}
      onDrop={drop}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDragging(false)
      }}
    >
      <button type="button" className="bank-card-open" onClick={() => onOpen('all')}>
        <span className="bank-card-top">
          <span className="icon-tile">
            <Icon size={21} aria-hidden="true" />
          </span>
          <ArrowUpRight size={17} aria-hidden="true" />
        </span>
        <strong>{bank.name}</strong>
        <span className="bank-hint">
          {dragging ? '松开以选择导入' : BANK_TEMPLATES[bank.template]}
        </span>
      </button>
      <div className="bank-book-links">
        <button type="button" className="secondary-button" onClick={() => onOpen('mistakes')}>
          错题本
        </button>
        <button type="button" className="secondary-button" onClick={() => onOpen('favorites')}>
          收藏本
        </button>
      </div>
      <div className="bank-actions bank-card-actions">
        <button
          type="button"
          className="secondary-button button-with-icon"
          onClick={() => onAction({ kind: 'add', bank })}
        >
          <Plus size={14} aria-hidden="true" />
          添加题目
        </button>
        <button
          type="button"
          className="secondary-button button-with-icon"
          onClick={() => onAction({ kind: 'import', bank, files: [] })}
        >
          <FileUp size={14} aria-hidden="true" />
          导入
        </button>
        <button
          type="button"
          className="quiet-danger-button"
          onClick={() => onAction({ kind: 'delete', bank })}
        >
          删除
        </button>
      </div>
    </article>
  )
}

function BankWorkspace({ api }: { api: PingoApi }) {
  const [banks, setBanks] = useState<readonly QuestionBank[]>()
  const [selectedId, setSelectedId] = useState('')
  const [source, setSource] = useState<PracticeSource>('all')
  const [mode, setMode] = useState<Mode>()
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [revision, setRevision] = useState(0)
  const selected = banks?.find((bank) => bank.id === selectedId)
  const close = () => setMode(undefined)

  useEffect(() => {
    let active = true
    void api
      .listBanks()
      .then((value) => {
        if (active) setBanks(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(requestMessage(cause))
      })
    return () => {
      active = false
    }
  }, [api, attempt])

  return (
    <>
      {selected && (
        <button
          type="button"
          onClick={() => {
            setSelectedId('')
            setStatus('')
          }}
          className="bank-back button-with-icon"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          全部题库
        </button>
      )}
      <header className="page-header bank-header">
        <div>
          <h1 id="page-title">{selected?.name ?? '题库'}</h1>
          <p>
            {selected
              ? BANK_TEMPLATES[selected.template]
              : '创建题库后，可手动添加题目或拖入 JSON 文件。'}
          </p>
        </div>
        {selected ? (
          <div className="bank-actions">
            <button
              type="button"
              className="secondary-button button-with-icon"
              onClick={() => setMode({ kind: 'import', bank: selected, files: [] })}
            >
              <FileUp size={16} aria-hidden="true" />
              导入 JSON
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setMode({ kind: 'rename', bank: selected })}
            >
              重命名
            </button>
            <button
              type="button"
              className="quiet-danger-button"
              onClick={() => setMode({ kind: 'delete', bank: selected })}
            >
              删除题库
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="primary-button button-with-icon"
            disabled={!banks}
            onClick={() => setMode({ kind: 'create' })}
          >
            <Plus size={16} aria-hidden="true" />
            新建题库
          </button>
        )}
      </header>
      {status && (
        <p className="bank-hint bank-notice" role="status">
          {status}
        </p>
      )}
      {selected ? (
        <>
          <nav aria-label="题库分组" className="bank-actions bank-book-tabs">
            {bookSources.map((book) => (
              <button
                key={book}
                type="button"
                className="secondary-button"
                aria-pressed={source === book}
                onClick={() => setSource(book)}
              >
                {PRACTICE_SOURCES[book]}
              </button>
            ))}
          </nav>
          <QuestionList
            key={`${selected.id}:${source}`}
            api={api}
            bank={selected}
            revision={revision}
            source={source}
          />
        </>
      ) : banks?.length ? (
        <div className="bank-grid">
          {banks.map((bank) => (
            <BankCard
              key={bank.id}
              bank={bank}
              onAction={setMode}
              onOpen={(book) => {
                setStatus('')
                setSelectedId(bank.id)
                setSource(book)
              }}
            />
          ))}
        </div>
      ) : banks ? (
        <EmptyState
          icon={BookOpen}
          title="暂无题库"
          description="选择基础模板或语言学习模板，创建你的第一个题库。"
        />
      ) : error ? (
        <>
          <p className="bank-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setError('')
              setAttempt(attempt + 1)
            }}
          >
            重试
          </button>
        </>
      ) : (
        <p className="bank-hint" role="status">
          正在读取题库…
        </p>
      )}

      {mode?.kind === 'create' && (
        <BankNameDialog
          onClose={close}
          onSave={async (name, template) => {
            const bank = await api.createBank({ name, template })
            setBanks((items) => [...(items ?? []), bank])
            setStatus(`已创建「${bank.name}」。`)
          }}
        />
      )}
      {mode?.kind === 'rename' && (
        <BankNameDialog
          bank={mode.bank}
          onClose={close}
          onSave={async (name) => {
            const bank = await api.renameBank({ bankId: mode.bank.id, name })
            setBanks((items) => items?.map((item) => (item.id === bank.id ? bank : item)))
            setStatus('')
          }}
        />
      )}
      {mode?.kind === 'delete' && (
        <ActionDialog
          title="删除题库"
          label="确认删除"
          destructive
          onClose={close}
          onSubmit={async () => {
            await api.deleteBank({ bankId: mode.bank.id })
            setBanks((items) => items?.filter((item) => item.id !== mode.bank.id))
            if (selectedId === mode.bank.id) setSelectedId('')
            setStatus(`已删除「${mode.bank.name}」。`)
          }}
        >
          <p className="bank-confirm">将永久删除「{mode.bank.name}」和其中的所有题目。</p>
        </ActionDialog>
      )}
      {mode?.kind === 'add' && (
        <QuestionEditor
          template={mode.bank.template}
          onClose={close}
          onSave={async (question) => {
            await api.createQuestion({ bankId: mode.bank.id, question })
            setRevision((value) => value + 1)
            setStatus(`已向「${mode.bank.name}」添加题目。`)
          }}
        />
      )}
      {mode?.kind === 'import' && (
        <BankImportDialog
          bank={mode.bank}
          initialFiles={mode.files}
          onCopy={() => api.copyQuestionImportPrompt(mode.bank.template)}
          onClose={close}
          onImport={async (json) => {
            const result = await api.appendQuestionImport({ bankId: mode.bank.id, json })
            setRevision((value) => value + 1)
            const imported = result.materials
              ? `${result.added} 道题和 ${result.materials} 份学习资料`
              : `${result.added} 道题`
            setStatus(`已向「${mode.bank.name}」导入 ${imported}。`)
          }}
        />
      )}
    </>
  )
}

export function QuestionBankPage() {
  return window.pingo ? (
    <BankWorkspace api={window.pingo} />
  ) : (
    <header className="page-header">
      <h1 id="page-title">题库</h1>
      <p>请在 Pingo 桌面应用中管理本地题库。</p>
    </header>
  )
}
