import { useEffect, useState } from 'react'

export function desktopError(error: unknown): string {
  return error instanceof Error ? error.message : '桌面操作失败，请重试。'
}

export function useDesktopValue<T>(
  read?: () => Promise<T>,
  subscribe?: (listener: (value: T) => void) => () => void,
) {
  const [value, setValue] = useState<T>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (!read || !subscribe) return
    let active = true
    let receivedEvent = false
    const unsubscribe = subscribe((next) => {
      if (!active) return
      receivedEvent = true
      setValue(next)
      setError('')
    })
    void read()
      .then((next) => {
        if (active && !receivedEvent) setValue(next)
      })
      .catch((cause: unknown) => {
        if (active && !receivedEvent) setError(desktopError(cause))
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [read, subscribe])

  return { value, error }
}
