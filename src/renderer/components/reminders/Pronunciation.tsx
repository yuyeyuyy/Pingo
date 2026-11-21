import { Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PingoApi } from '../../../shared/ipc'
import { DEFAULT_PRONUNCIATION_PREFERENCES, pronunciationForView } from '../../../shared/reminders'
import type { PronunciationView } from '../../../shared/reminders'
import { selectLocalVoice, waitForRecording } from './pronunciation-playback'
import { speakWithVoice } from './system-voice'
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

    const preferences = view.pronunciationPreferences ?? DEFAULT_PRONUNCIATION_PREFERENCES
    const voice = selectLocalVoice(
      window.speechSynthesis?.getVoices() ?? [],
      language,
      preferences.voiceURI,
    )

    function fallback(reason: string) {
      if (request !== current.request) return
      current.stop?.()
      current.stop = undefined
      if (!voice) {
        setMessage(reason)
        return
      }
      current.stop = speakWithVoice(voice, word, preferences.rate, {
        end() {
          current.stop = undefined
        },
        error() {
          current.stop = undefined
          if (request === current.request) setMessage(reason)
        },
      })
    }

    try {
      if (preferences.source === 'system' && voice) {
        fallback('本机语音暂时无法播放。')
        return
      }
      const clip = await waitForRecording(api.getPronunciation(target), !!voice)
      if (request !== current.request) return
      if (!clip) {
        fallback(clip === undefined ? '词典录音未及时返回。' : '词典暂无这个单词的录音。')
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
      if (request === current.request) {
        setMessage('词典录音')
        audio.onerror = () => fallback('这段录音暂时无法播放。')
      }
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
