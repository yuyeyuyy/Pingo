import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { requestMessage } from './feedback'

interface ActionDialogProps {
  title: string
  label: string
  destructive?: boolean
  children: ReactNode
  onSubmit(): Promise<void>
  onClose(): void
}

export function ActionDialog({
  title,
  label,
  destructive,
  children,
  onSubmit,
  onClose,
}: ActionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onSubmit()
      onClose()
    } catch (cause) {
      setError(requestMessage(cause))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="bank-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form onSubmit={submit}>
        <h2 id={titleId}>{title}</h2>
        <fieldset className="bank-dialog-fields" disabled={busy}>
          {children}
        </fieldset>
        {error && (
          <p className="bank-error" role="alert">
            {error}
          </p>
        )}
        <footer className="bank-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="submit"
            className={destructive ? 'danger-button' : 'primary-button'}
            disabled={busy}
          >
            {busy ? '处理中…' : label}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
