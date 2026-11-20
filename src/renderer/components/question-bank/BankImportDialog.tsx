import { Copy, FileUp } from 'lucide-react'
import { useRef, useState } from 'react'
import type { QuestionBank } from '../../../shared/question-bank'
import { BANK_LIMITS } from '../../../shared/question-bank'
import { conversionPrompt } from '../../../shared/question-import-prompt'
import { ActionDialog } from './ActionDialog'

export function BankImportDialog({
  bank,
  initialFiles,
  onImport,
  onCopy,
  onClose,
}: {
  bank: QuestionBank
  initialFiles: readonly File[]
  onImport(json: string): Promise<void>
  onCopy(): Promise<void>
  onClose(): void
}) {
  const [files, setFiles] = useState(initialFiles)
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const prompt = conversionPrompt(bank.template)

  async function submit() {
    const file = files[0]
    if (files.length !== 1 || !file) throw new Error('请选择一个 JSON 文件。')
    if (!file.name.toLowerCase().endsWith('.json')) throw new Error('请选择扩展名为 .json 的文件。')
    if (file.size > BANK_LIMITS.importBytes) throw new Error('单个文件不能超过 32 MiB。')
    let json: string
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    } catch {
      throw new Error('无法读取文件。请确认它采用 UTF-8 编码。')
    }
    await onImport(json)
  }

  async function copyPrompt() {
    try {
      await onCopy()
      setCopied('提示词已复制。')
    } catch {
      setCopied('可以在下方选中提示词并复制。')
    }
  }

  return (
    <ActionDialog
      title={`导入到「${bank.name}」`}
      label="确认导入"
      onSubmit={submit}
      onClose={onClose}
    >
      <div
        className="bank-drop-zone"
        data-dragging={dragging}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.stopPropagation()
          if (event.currentTarget.closest('fieldset')?.disabled) return
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
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          if (!event.currentTarget.closest('fieldset')?.disabled)
            setFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <FileUp size={22} aria-hidden="true" />
        <p className="bank-drop-filename" role="status">
          {files.length > 1 ? '请一次选择一个文件。' : (files[0]?.name ?? '将 JSON 文件拖到此处')}
        </p>
        <input
          type="file"
          ref={input}
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            if (event.target.files?.length) setFiles(Array.from(event.target.files))
            event.target.value = ''
          }}
        />
        <button type="button" className="secondary-button" onClick={() => input.current?.click()}>
          选择 JSON
        </button>
        <p className="bank-hint">UTF-8 JSON · 单文件最多 32 MiB</p>
      </div>
      <details className="bank-import-help">
        <summary>用 Agent 转换已有题库</summary>
        <p className="bank-hint">把原始文件与提示词一起交给 Agent，让它编写脚本批量转换。</p>
        <button type="button" className="secondary-button button-with-icon" onClick={copyPrompt}>
          <Copy size={14} aria-hidden="true" />
          复制提示词
        </button>
        <textarea
          aria-label="题库转换提示词"
          className="bank-prompt"
          readOnly
          value={prompt}
          rows={6}
        />
        {copied && (
          <p className="bank-hint" role="status">
            {copied}
          </p>
        )}
      </details>
    </ActionDialog>
  )
}
