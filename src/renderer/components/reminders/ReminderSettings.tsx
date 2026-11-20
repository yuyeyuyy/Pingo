import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { PingoApi } from '../../../shared/ipc'
import { PRACTICE_SOURCES } from '../../../shared/question-bank'
import type { PracticeSource, QuestionBank } from '../../../shared/question-bank'
import {
  DEFAULT_PRACTICE_SETTINGS,
  INTERVAL_PRESETS,
  PAUSE_OPTIONS,
  QUESTION_PRESETS,
} from '../../../shared/reminders'
import type {
  PauseOption,
  ReminderSettings as Settings,
  ReminderStatus,
} from '../../../shared/reminders'
import { desktopError, useDesktopValue } from './useDesktopValue'

const intervalNames = [
  '高频学习 · 5 分钟',
  '轻量学习 · 15 分钟',
  '日常学习 · 30 分钟',
  '低频学习 · 1 小时',
  '偶尔复习 · 2 小时',
]
const practiceSources = Object.keys(PRACTICE_SOURCES) as PracticeSource[]
const phaseNames: Record<ReminderStatus['phase'], string> = {
  STOPPED: '定时提醒已关闭',
  WAITING: '等待下次提醒',
  DUE: '有一轮学习待开始',
  SESSION_ACTIVE: '学习进行中',
  SNOOZED: '稍后继续本轮',
  PAUSED: '提醒已暂停',
}

function clock(minutes: number): string {
  return [Math.floor(minutes / 60), minutes % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function minutesOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return (hour ?? NaN) * 60 + (minute ?? NaN)
}

function preset(value: number, choices: readonly number[]) {
  return choices.includes(value) ? String(value) : 'custom'
}

function ReminderForm({ settings, api }: { settings: Settings; api: PingoApi }) {
  const [draft, setDraft] = useState(settings)
  const originalPractice = settings.practice ?? DEFAULT_PRACTICE_SETTINGS
  const [bankId, setBankId] = useState(originalPractice.bankId ?? '')
  const [source, setSource] = useState(originalPractice.source)
  const [frequency, setFrequency] = useState(String(originalPractice.wrongEvery))
  const [banks, setBanks] = useState<readonly QuestionBank[]>()
  const [banksError, setBanksError] = useState('')
  const [interval, setInterval] = useState(preset(settings.intervalMinutes, INTERVAL_PRESETS))
  const [intervalValue, setIntervalValue] = useState(String(settings.intervalMinutes))
  const [unit, setUnit] = useState<'minutes' | 'hours'>('minutes')
  const [count, setCount] = useState(preset(settings.questionsPerSession, QUESTION_PRESETS))
  const [countValue, setCountValue] = useState(String(settings.questionsPerSession))
  const [quiet, setQuiet] = useState(settings.quietHours !== null)
  const [quietStart, setQuietStart] = useState(clock(settings.quietHours?.start ?? 1380))
  const [quietFinish, setQuietFinish] = useState(clock(settings.quietHours?.end ?? 480))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    void api
      .listBanks()
      .then((value) => {
        if (active) setBanks(value)
      })
      .catch((cause: unknown) => {
        if (active) setBanksError(desktopError(cause))
      })
    return () => {
      active = false
    }
  }, [api])

  function change<K extends keyof Settings>(field: K, value: Settings[K]) {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const rawMinutes =
        interval === 'custom'
          ? Number(intervalValue) * (unit === 'hours' ? 60 : 1)
          : Number(interval)
      const rounded = Math.round(rawMinutes)
      if (!Number.isFinite(rawMinutes) || Math.abs(rounded - rawMinutes) > 0.000001) {
        throw new Error('提醒间隔须能换算为整分钟。')
      }
      await api.saveReminderSettings({
        ...draft,
        practice: { bankId: bankId || null, source, wrongEvery: Number(frequency) },
        intervalMinutes: rounded,
        questionsPerSession: Number(count === 'custom' ? countValue : count),
        quietHours: quiet
          ? { start: minutesOfDay(quietStart), end: minutesOfDay(quietFinish) }
          : null,
      })
      setSaved(true)
    } catch (cause) {
      setError(desktopError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-panel reminder-form" onSubmit={save} onChange={() => setSaved(false)}>
      <fieldset disabled={busy}>
        <label className="reminder-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => change('enabled', event.target.checked)}
          />
          启用定时学习
        </label>
        <div className="reminder-fields">
          <label className="bank-field">
            学习题库
            <select
              value={bankId}
              aria-label="学习题库"
              disabled={!banks}
              onChange={(event) => setBankId(event.target.value)}
            >
              <option value="">全部题库</option>
              {bankId && !banks?.some((bank) => bank.id === bankId) && (
                <option value={bankId}>{banks ? '原题库已删除' : '正在读取所选题库'}</option>
              )}
              {banks?.map((bank) => (
                <option value={bank.id} key={bank.id}>
                  {bank.name}
                </option>
              ))}
            </select>
          </label>
          <label className="bank-field">
            抽题范围
            <select
              value={source}
              aria-label="抽题范围"
              onChange={(event) => {
                const selected = practiceSources.find((item) => item === event.target.value)
                if (selected) setSource(selected)
              }}
            >
              {practiceSources.map((item) => (
                <option value={item} key={item}>
                  {PRACTICE_SOURCES[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="bank-field">
            学习模式
            <select
              aria-label="学习模式"
              value={draft.sessionMode ?? 'practice'}
              onChange={(event) =>
                change('sessionMode', event.target.value === 'study' ? 'study' : 'practice')
              }
            >
              <option value="practice">练习模式</option>
              <option value="study">学习模式</option>
            </select>
            <span className="bank-hint">
              {draft.sessionMode === 'study'
                ? '优先展示没学过的内容，每份资料对应一道练习题。'
                : '直接开始答题。'}
            </span>
          </label>
          <label className="bank-field">
            学习策略
            <select
              aria-label="学习策略"
              value={draft.strategy ?? 'random'}
              onChange={(event) =>
                change('strategy', event.target.value === 'progressive' ? 'progressive' : 'random')
              }
            >
              <option value="progressive">循序渐进</option>
              <option value="random">随机抽题</option>
            </select>
          </label>
        </div>
        {banksError && (
          <p className="bank-error" role="alert">
            {banksError}
          </p>
        )}
        {source === 'all' && (
          <label className="bank-field">
            每隔几轮抽取错题
            <input
              type="number"
              min={0}
              step={1}
              required
              value={frequency}
              onChange={(event) => setFrequency(event.target.value)}
            />
            <span className="bank-hint">
              按完成的轮次计算。例如填 3 时，第 3、6、9 轮抽错题。填 0 关闭。
            </span>
          </label>
        )}
        {source === 'mistakes' && (
          <p className="bank-hint">错题本为空时，从所选题库的完整题目抽取。</p>
        )}
        {source === 'favorites' && <p className="bank-hint">收藏本为空时暂停本轮抽题。</p>}
        <div className="reminder-fields">
          <label className="bank-field">
            提醒间隔
            <select value={interval} onChange={(event) => setInterval(event.target.value)}>
              {INTERVAL_PRESETS.map((value, index) => (
                <option key={value} value={value}>
                  {intervalNames[index]}
                </option>
              ))}
              <option value="custom">自定义间隔</option>
            </select>
          </label>
          <label className="bank-field">
            每次题量
            <select
              aria-label="每次题量"
              value={count}
              onChange={(event) => setCount(event.target.value)}
            >
              {QUESTION_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {value} 道
                </option>
              ))}
              <option value="custom">自定义题量</option>
            </select>
          </label>
        </div>
        {interval === 'custom' && (
          <div className="reminder-fields">
            <label className="bank-field">
              自定义提醒间隔
              <input
                type="number"
                required
                step={unit === 'minutes' ? 1 : 'any'}
                value={intervalValue}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
            <label className="bank-field">
              时间单位
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value === 'hours' ? 'hours' : 'minutes')}
              >
                <option value="minutes">分钟</option>
                <option value="hours">小时</option>
              </select>
            </label>
          </div>
        )}
        {count === 'custom' && (
          <label className="bank-field">
            自定义每次题量
            <input
              type="number"
              min={1}
              max={20}
              required
              value={countValue}
              onChange={(event) => setCountValue(event.target.value)}
            />
          </label>
        )}
        <label className="bank-field">
          提醒方式
          <select
            value={draft.mode}
            onChange={(event) =>
              change('mode', event.target.value === 'popup' ? 'popup' : 'notification')
            }
          >
            <option value="notification">轻提醒（点击系统通知后答题）</option>
            <option value="popup">主动弹窗</option>
          </select>
        </label>
        {draft.mode === 'popup' && (
          <label className="reminder-check">
            <input
              type="checkbox"
              checked={draft.focusPopup}
              onChange={(event) => change('focusPopup', event.target.checked)}
            />
            允许主动弹窗获得键盘焦点
          </label>
        )}
        <details className="reminder-details">
          <summary>勿扰设置</summary>
          <div className="reminder-details-body">
            <label className="reminder-check">
              <input
                type="checkbox"
                checked={draft.avoidFullscreen}
                onChange={(event) => change('avoidFullscreen', event.target.checked)}
              />
              全屏时避免主动弹窗
            </label>
            <p className="bank-hint">无法确认其他应用的全屏状态时，改用轻提醒。</p>
            <label className="reminder-check">
              <input
                type="checkbox"
                checked={draft.avoidIdle}
                onChange={(event) => change('avoidIdle', event.target.checked)}
              />
              空闲 5 分钟或锁屏时勿扰
            </label>
            <label className="reminder-check">
              <input
                type="checkbox"
                checked={quiet}
                onChange={(event) => setQuiet(event.target.checked)}
              />
              每日勿扰时段
            </label>
            {quiet && (
              <div className="reminder-fields">
                <label className="bank-field">
                  开始时间
                  <input
                    required
                    type="time"
                    value={quietStart}
                    onChange={(event) => setQuietStart(event.target.value)}
                  />
                </label>
                <label className="bank-field">
                  结束时间
                  <input
                    required
                    type="time"
                    value={quietFinish}
                    onChange={(event) => setQuietFinish(event.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        </details>
      </fieldset>
      {error && (
        <p className="bank-error" role="alert">
          {error}
        </p>
      )}
      <div className="bank-actions">
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? '保存中…' : '保存提醒设置'}
        </button>
        {saved && (
          <p className="bank-hint" role="status">
            设置已保存
          </p>
        )}
      </div>
    </form>
  )
}

function ReminderControls({ api, status }: { api: PingoApi; status: ReminderStatus }) {
  const [pause, setPause] = useState<PauseOption>(30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const time = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const pendingId = status.pendingSessionId
  const next = status.nextAt === null ? '—' : time.format(status.nextAt)

  async function run(action: () => Promise<ReminderStatus>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(desktopError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-panel reminder-controls">
      <div role="status">
        <strong>{phaseNames[status.phase]}</strong>
        <p className="bank-hint">下次预计提醒 {next}</p>
        {status.pauseUntil !== null && (
          <p className="bank-hint">暂停至 {time.format(status.pauseUntil)}</p>
        )}
        {status.pendingSessionId && (
          <p className="bank-hint">你可以从这里继续学习。系统通知取决于 macOS 的通知设置。</p>
        )}
        {status.notice === 'empty-bank' && (
          <p className="bank-hint">所选题库暂无题目。可切换题库或添加题目。</p>
        )}
        {status.notice === 'empty-favorites' && (
          <p className="bank-hint">所选收藏本暂无题目。可切换抽题范围或先收藏题目。</p>
        )}
        {status.notice === 'empty-study' && (
          <p className="bank-hint">
            所选范围暂无关联学习资料的题目。可导入带资料的题库，或切换到练习模式。
          </p>
        )}
        {status.learning && (
          <p className="bank-hint">
            {status.learning.level
              ? `当前难度 ${status.learning.level} / 5 · `
              : !status.settings.practice?.bankId
                ? '各题库独立进阶 · '
                : ''}
            {status.learning.dueCount} 道待复习
          </p>
        )}
        {status.notice === 'nothing-due' && (
          <p className="bank-hint">当前没有到期题或合适的新题。可以点「立即学习」提前练一道。</p>
        )}
      </div>
      <div className="bank-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => run(api.startLearning)}
        >
          {status.pendingSessionId ||
          status.phase === 'SNOOZED' ||
          status.phase === 'SESSION_ACTIVE'
            ? '继续学习'
            : '立即学习'}
        </button>
        {pendingId && (
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => run(() => api.skipPendingLearning(pendingId))}
          >
            跳过本轮
          </button>
        )}
        {status.pauseUntil !== null ? (
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => run(api.resumeReminders)}
          >
            恢复提醒
          </button>
        ) : (
          <>
            <label className="bank-field">
              <select
                aria-label="暂停时长"
                disabled={busy || !status.settings.enabled}
                value={pause}
                onChange={(event) => {
                  const option = PAUSE_OPTIONS.find((value) => String(value) === event.target.value)
                  if (option !== undefined) setPause(option)
                }}
              >
                <option value={30}>30 分钟</option>
                <option value={60}>1 小时</option>
                <option value={120}>2 小时</option>
                <option value="tomorrow">直到明天</option>
              </select>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || !status.settings.enabled}
              onClick={() => run(() => api.pauseReminders(pause))}
            >
              暂停提醒
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="bank-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function ReminderSettings() {
  const api = window.pingo
  const { value, error } = useDesktopValue(api?.getReminderStatus, api?.onReminderStatus)

  return (
    <section className="settings-section" aria-labelledby="reminder-heading">
      <h2 id="reminder-heading">学习提醒</h2>
      {api && value ? (
        <>
          <ReminderControls api={api} status={value} />
          <ReminderForm api={api} settings={value.settings} />
        </>
      ) : (
        <p className="bank-hint" role="status">
          {api ? error || '正在读取提醒设置…' : '请在 Pingo 桌面应用中配置学习提醒。'}
        </p>
      )}
    </section>
  )
}
