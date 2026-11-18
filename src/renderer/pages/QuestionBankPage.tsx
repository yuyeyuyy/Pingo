import { BookOpen, FileUp, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { PingoApi } from '../../shared/ipc'
import { BANK_LIMITS } from '../../shared/question-bank'
import type { QuestionBank } from '../../shared/question-bank'
import { EmptyState } from '../components/EmptyState'
import { ActionDialog } from '../components/question-bank/ActionDialog'
import { QuestionList } from '../components/question-bank/QuestionList'
import { requestMessage } from '../components/question-bank/feedback'

function BankNameDialog({
  bank,
  onSave,
  onClose,
}: {
  bank?: QuestionBank
  onSave(name: string): Promise<void>
  onClose(): void
}) {
  const [name, setName] = useState(bank?.name ?? '')
  return (
    <ActionDialog
      title={bank ? '重命名题库' : '新建题库'}
      label={bank ? '保存名称' : '创建题库'}
      onSubmit={() => onSave(name)}
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
    </ActionDialog>
  )
}

function BankWorkspace({ api }: { api: PingoApi }) {
  const [banks, setBanks] = useState<readonly QuestionBank[]>()
  const [selectedId, setSelectedId] = useState<string>()
  const [mode, setMode] = useState<'create' | 'rename' | 'delete'>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    void api
      .listBanks()
      .then((value) => {
        if (!active) return
        setBanks(value)
        setSelectedId(value[0]?.id)
      })
      .catch((cause: unknown) => {
        if (active) setError(requestMessage(cause))
      })
    return () => {
      active = false
    }
  }, [api, attempt])

  const selected = banks?.find((bank) => bank.id === selectedId)

  function addBank(bank: QuestionBank) {
    setBanks((items) => [...(items ?? []), bank])
    setSelectedId(bank.id)
  }

  async function importBank(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || importing) return
    setImporting(true)
    setError('')
    setImportMessage('')
    try {
      if (file.size > BANK_LIMITS.importBytes) throw new Error('请选择不超过 4 MiB 的 JSON 文件。')
      const bank = await api.importQuestionBank(await file.text())
      addBank(bank)
      setImportMessage(`已导入「${bank.name}」。`)
    } catch (cause) {
      setError(requestMessage(cause))
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <header className="page-header bank-header">
        <div>
          <h1 id="page-title">题库</h1>
          <p>创建、导入和管理本地题目。</p>
        </div>
        <div className="bank-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={importBank}
          />
          <button
            type="button"
            className="secondary-button button-with-icon"
            disabled={!banks || importing}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp size={16} aria-hidden="true" />
            {importing ? '正在导入…' : '导入 JSON'}
          </button>
          <button
            type="button"
            className="primary-button button-with-icon"
            disabled={!banks || importing}
            onClick={() => setMode('create')}
          >
            <Plus size={16} aria-hidden="true" />
            新建题库
          </button>
        </div>
      </header>

      {error && (
        <p className="bank-error bank-notice" role="alert">
          {error}
        </p>
      )}
      {importMessage && (
        <p className="bank-notice bank-hint" role="status">
          {importMessage}
        </p>
      )}

      {selected && banks ? (
        <>
          <div className="bank-toolbar">
            <label className="bank-field">
              当前题库
              <select
                value={selected.id}
                onChange={(event) => {
                  setSelectedId(event.target.value)
                  setImportMessage('')
                }}
              >
                {banks.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {bank.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="bank-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={importing}
                onClick={() => setMode('rename')}
              >
                重命名
              </button>
              <button
                className="quiet-danger-button"
                type="button"
                disabled={importing}
                onClick={() => setMode('delete')}
              >
                删除题库
              </button>
            </div>
          </div>
          <QuestionList key={selected.id} api={api} bankId={selected.id} />
        </>
      ) : banks ? (
        <EmptyState
          icon={BookOpen}
          title="暂无题库"
          description="新建一个题库，或导入包含题目的 JSON 文件。"
        />
      ) : error ? (
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
      ) : (
        <p className="bank-hint" role="status">
          正在读取题库…
        </p>
      )}

      {mode === 'create' && (
        <BankNameDialog
          onClose={() => setMode(undefined)}
          onSave={async (name) => {
            addBank(await api.createBank({ name }))
            setImportMessage('')
          }}
        />
      )}
      {mode === 'rename' && selected && (
        <BankNameDialog
          bank={selected}
          onClose={() => setMode(undefined)}
          onSave={async (name) => {
            const renamed = await api.renameBank({ bankId: selected.id, name })
            setBanks((items) => items?.map((bank) => (bank.id === renamed.id ? renamed : bank)))
            setImportMessage('')
          }}
        />
      )}
      {mode === 'delete' && selected && banks && (
        <ActionDialog
          title="删除题库"
          label="确认删除"
          destructive
          onClose={() => setMode(undefined)}
          onSubmit={async () => {
            await api.deleteBank({ bankId: selected.id })
            const remaining = banks.filter((bank) => bank.id !== selected.id)
            setBanks(remaining)
            setSelectedId(remaining[0]?.id)
            setImportMessage('')
          }}
        >
          <p className="bank-confirm">将永久删除「{selected.name}」和其中的所有题目。</p>
        </ActionDialog>
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
