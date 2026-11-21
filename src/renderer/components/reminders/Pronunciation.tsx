import { Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PingoApi } from '../../../shared/ipc'
import { pronunciationForView } from '../../../shared/reminders'
import type { PronunciationView } from '../../../shared/reminders'
import { desktopError } from './useDesktopValue'

export function usePronunciation(api: PingoApi, view: PronunciationView) {
  const active = useRef<{ request: number; stop?: () => void }>({ request: 0 })
  const [pending, setPending] = useState<number | 'prompt' | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const current = active.current
    // Some systems load their installed voices asynchronously on first access.
    window.speechSynthesis?.getVoices()
    return () => {
      current.request++
      current.stop?.()
      current.stop = undefined
    }
  }, [])

  async function play(optionIndex?: number) {
    const lookup = pronunciationForView(view, optionIndex)
    if (!lookup) return
    const { language, word } = lookup
    const { sessionId } = view
    const target =
      view.kind === 'material'
        ? { sessionId, position: view.position }
        : { sessionId, questionId: view.question.id, optionIndex }
    const current = active.current
    const request = ++current.request
    current.stop?.()
    current.stop = undefined
    setPending(optionIndex ?? 'prompt')
    setMessage('')

    function fallback(reason: string) {
      if (request !== current.request) return
      current.stop?.()
      current.stop = undefined
      const synthesis = window.speechSynthesis
      const voices = synthesis
        ?.getVoices()
        .filter(
          (voice) => voice.localService && voice.lang.toLowerCase().split(/[-_]/)[0] === language,
        )
      const voice = voices?.find((voice) => voice.default) ?? voices?.[0]
      if (!voice) {
        setMessage(reason)
        return
      }
      const utterance = new SpeechSynthesisUtterance(word)
      utterance.lang = voice.lang
      utterance.voice = voice
      current.stop = () => {
        utterance.onend = null
        utterance.onerror = null
        synthesis.cancel()
      }
      utterance.onend = () => {
        current.stop = undefined
      }
      utterance.onerror = () => {
        current.stop = undefined
        if (request === current.request) setMessage(reason)
      }
      synthesis.speak(utterance)
      setMessage('使用系统发音。')
    }

    try {
      const clip = await api.getPronunciation(target)
      if (request !== current.request) return
      if (!clip) {
        fallback('词典暂无这个单词的录音。')
        return
      }
      const url = URL.createObjectURL(new Blob([clip.bytes], { type: clip.mimeType }))
      const audio = new Audio(url)
      current.stop = () => {
        audio.onended = null
        audio.onerror = null
        audio.pause()
        URL.revokeObjectURL(url)
      }
      audio.onended = () => {
        current.stop?.()
        current.stop = undefined
      }
      await audio.play().catch(() => {
        throw new Error('这段录音暂时无法播放。')
      })
      if (request === current.request) audio.onerror = () => fallback('这段录音暂时无法播放。')
    } catch (error) {
      fallback(desktopError(error))
    } finally {
      if (request === current.request) setPending(null)
    }
  }

  return { play, pending, message }
}

export function PronunciationButton({
  word,
  busy,
  onPlay,
}: {
  word: string
  busy: boolean
  onPlay(): void
}) {
  return (
    <button
      type="button"
      className="pronunciation-word"
      aria-label={`播放 ${word} 的发音`}
      aria-busy={busy}
      disabled={busy}
      onClick={onPlay}
    >
      {word}
      <Volume2 size={14} aria-hidden="true" />
    </button>
  )
}
