import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { PingoApi } from '../../../shared/ipc'
import { DEFAULT_PRONUNCIATION_PREFERENCES, PRONUNCIATION_RATE } from '../../../shared/reminders'
import type { PronunciationPreferences } from '../../../shared/reminders'
import { listLocalVoices, selectLocalVoice } from './pronunciation-playback'
import { speakWithVoice } from './system-voice'
import { desktopError, useDesktopValue } from './useDesktopValue'

function availableVoices() {
  return listLocalVoices(window.speechSynthesis?.getVoices() ?? [], 'en').sort((left, right) =>
    left.name.localeCompare(right.name),
  )
}

function PronunciationForm({ api, initial }: { api: PingoApi; initial: PronunciationPreferences }) {
  const [draft, setDraft] = useState(initial)
  const [voices, setVoices] = useState(availableVoices)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const stopPreview = useRef<(() => void) | null>(null)
  const voice = selectLocalVoice(voices, 'en', draft.voiceURI)
  const missingVoice = draft.voiceURI && !voices.some((item) => item.voiceURI === draft.voiceURI)

  useEffect(() => {
    const synthesis = window.speechSynthesis
    const refresh = () => setVoices(availableVoices())
    synthesis?.addEventListener('voiceschanged', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      synthesis?.removeEventListener('voiceschanged', refresh)
      window.removeEventListener('focus', refresh)
      stopPreview.current?.()
    }
  }, [])

  function change(update: Partial<PronunciationPreferences>) {
    stopPreview.current?.()
    stopPreview.current = null
    setPreviewing(false)
    setDraft((previous) => ({ ...previous, ...update }))
    setStatus('')
    setError('')
  }

  function preview() {
    if (!voice || previewing) return
    setPreviewing(true)
    setError('')
    function finish() {
      stopPreview.current = null
      setPreviewing(false)
    }
    stopPreview.current = speakWithVoice(
      voice,
      'Hello. Apple. What would you like to learn today?',
      draft.rate,
      {
        end: finish,
        error() {
          finish()
          setError('暂时无法播放这款本机语音。')
        },
      },
    )
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setStatus('')
    setError('')
    try {
      await api.savePronunciationPreferences(draft)
      setStatus('已保存发音设置。')
    } catch (cause) {
      setError(desktopError(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="settings-panel reminder-form" onSubmit={save}>
      <fieldset disabled={saving}>
        <div className="reminder-fields">
          <label className="bank-field">
            发音来源
            <select
              aria-label="发音来源"
              value={draft.source}
              onChange={(event) =>
                change({ source: event.target.value === 'system' ? 'system' : 'dictionary' })
              }
            >
              <option value="dictionary">词典录音优先</option>
              <option value="system">本机语音优先</option>
            </select>
          </label>
          <label className="bank-field">
            本机英语语音
            <select
              aria-label="本机英语语音"
              value={draft.voiceURI ?? ''}
              onChange={(event) => change({ voiceURI: event.target.value || null })}
            >
              <option value="">自动选择</option>
              {missingVoice && <option value={draft.voiceURI!}>已保存的语音暂不可用</option>}
              {voices.map((item) => (
                <option key={item.voiceURI} value={item.voiceURI}>
                  {item.name} · {item.lang}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="bank-field">
          本机语速 {draft.rate}×
          <input
            type="range"
            aria-label="本机语速"
            min={PRONUNCIATION_RATE.min}
            max={PRONUNCIATION_RATE.max}
            step={0.05}
            value={draft.rate}
            onChange={(event) => change({ rate: Number(event.target.value) })}
          />
        </label>
        {voices.length === 0 ? (
          <p className="bank-hint">当前没有可用的本机英语语音。可在系统设置中安装。</p>
        ) : (
          <p className="bank-hint">
            本机语音优先可直接点读。词典录音优先会在录音不可用时使用所选语音。
          </p>
        )}
        <div className="bank-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!voice || previewing}
            onClick={preview}
          >
            {previewing ? '正在试听…' : '试听本机语音'}
          </button>
          <button type="submit" className="primary-button">
            保存发音设置
          </button>
        </div>
      </fieldset>
      {status && (
        <p className="bank-hint" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="bank-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

export function PronunciationSettings() {
  const api = window.pingo
  const { value, error } = useDesktopValue(api?.getReminderStatus, api?.onReminderStatus)
  return (
    <section className="settings-section" aria-labelledby="pronunciation-heading">
      <h2 id="pronunciation-heading">英语发音</h2>
      {api && value ? (
        <PronunciationForm
          api={api}
          initial={value.pronunciation ?? DEFAULT_PRONUNCIATION_PREFERENCES}
        />
      ) : (
        <p className="settings-note" role="status">
          {error || (api ? '正在读取发音设置…' : '请在 Pingo 桌面应用中调整发音。')}
        </p>
      )}
    </section>
  )
}
