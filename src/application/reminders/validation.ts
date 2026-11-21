import { PAUSE_OPTIONS, SNOOZE_MINUTES } from '../../domain/scheduling'
import type { PauseOption, ReminderSettings } from '../../domain/scheduling'
import { PRACTICE_SOURCES } from '../../domain/review'
import type { PracticeSource } from '../../domain/review'
import { PRONUNCIATION_RATE } from '../../domain/pronunciation'
import type { PronunciationPreferences } from '../../domain/pronunciation'
import type { PronunciationTarget, SessionTarget, StudyMaterialTarget } from '../../domain/session'
import type {
  RateAnswerRequest,
  SetAnswerFavoriteRequest,
  SubmitAnswerRequest,
} from '../../shared/reminders'
import { BANK_LIMITS } from '../../shared/question-bank'
import { id } from '../question-bank/validation'
import { RequestError } from '../request-error'

export function invalid(message: string): never {
  throw new RequestError('INVALID_ARGUMENTS', message)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求格式无效。')
  return value as Record<string, unknown>
}

function integer(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    invalid(message)
  return value
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('提醒开关设置无效。')
  return value
}

export function reminderSettings(value: unknown): ReminderSettings {
  const input = record(value)
  const mode = input.mode
  if (mode !== 'notification' && mode !== 'popup') invalid('请选择有效的提醒方式。')
  const strategy = input.strategy
  if (strategy !== undefined && strategy !== 'random' && strategy !== 'progressive')
    invalid('请选择有效的学习策略。')
  const sessionMode = input.sessionMode
  if (
    sessionMode !== undefined &&
    sessionMode !== 'study' &&
    sessionMode !== 'practice' &&
    sessionMode !== 'learn'
  )
    invalid('请选择有效的学习模式。')
  let quietHours: ReminderSettings['quietHours'] = null
  if (input.quietHours !== null) {
    const { start, end } = record(input.quietHours)
    quietHours = {
      start: integer(start, 0, 1439, '勿扰开始时间无效。'),
      end: integer(end, 0, 1439, '勿扰结束时间无效。'),
    }
    if (quietHours.start === quietHours.end) invalid('勿扰时段的开始和结束时间必须不同。')
  }

  return {
    enabled: flag(input.enabled),
    intervalMinutes: integer(input.intervalMinutes, 1, 1440, '提醒间隔须为 1 至 1440 分钟。'),
    questionsPerSession: integer(
      input.questionsPerSession,
      1,
      20,
      sessionMode === 'learn' ? '每次资料数须为 1 至 20 份。' : '每次题量须为 1 至 20 道。',
    ),
    mode,
    focusPopup: flag(input.focusPopup),
    avoidFullscreen: flag(input.avoidFullscreen),
    avoidIdle: flag(input.avoidIdle),
    quietHours,
    ...(strategy === undefined ? {} : { strategy }),
    ...(sessionMode === undefined ? {} : { sessionMode }),
    ...(input.practice === undefined ? {} : { practice: practiceSettings(input.practice) }),
  }
}

function practiceSettings(input: unknown) {
  const { bankId, source, wrongEvery } = record(input)
  if (typeof source !== 'string' || !Object.hasOwn(PRACTICE_SOURCES, source))
    invalid('请选择有效的抽题范围。')
  return {
    bankId: bankId === null ? null : id(bankId),
    source: source as PracticeSource,
    wrongEvery: integer(wrongEvery, 0, Number.MAX_SAFE_INTEGER, '错题抽取频率必须为非负整数。'),
  }
}

export function pauseOption(input: unknown): PauseOption {
  const option = PAUSE_OPTIONS.find((value) => value === input)
  if (option === undefined) invalid('请选择有效的暂停时长。')
  return option
}

export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128)
    invalid('会话标识无效。')
  return value
}

export function sessionTarget(input: unknown): SessionTarget {
  const data = record(input)
  return { sessionId: sessionId(data.sessionId), questionId: sessionId(data.questionId) }
}

export function pronunciationTarget(input: unknown): PronunciationTarget {
  const data = record(input)
  if (data.position !== undefined) {
    if (data.questionId !== undefined || data.optionIndex !== undefined) invalid('发音位置无效。')
    return studyMaterialTarget(data)
  }
  const target = sessionTarget(data)
  if (data.optionIndex === undefined) return target
  return {
    ...target,
    optionIndex: integer(data.optionIndex, 0, BANK_LIMITS.maxOptions - 1, '选项序号无效。'),
  }
}

export function pronunciationPreferences(input: unknown): PronunciationPreferences {
  const { voiceURI, rate, source } = record(input)
  if (
    voiceURI !== null &&
    (typeof voiceURI !== 'string' ||
      !voiceURI.trim() ||
      voiceURI.length > 512 ||
      voiceURI.includes('\0'))
  )
    invalid('本机语音标识无效。')
  if (
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate < PRONUNCIATION_RATE.min ||
    rate > PRONUNCIATION_RATE.max
  )
    invalid('请输入有效的发音语速。')
  if (source !== 'dictionary' && source !== 'system') invalid('请选择有效的发音来源。')
  return { voiceURI, rate, source }
}

export function studyMaterialTarget(input: unknown): StudyMaterialTarget {
  const data = record(input)
  return {
    sessionId: sessionId(data.sessionId),
    position: integer(data.position, 1, 20, '学习资料位置无效。'),
  }
}

export function snoozeRequest(input: unknown) {
  const data = record(input)
  const minutes = SNOOZE_MINUTES.find((value) => value === data.minutes)
  if (minutes === undefined) invalid('请选择有效的稍后提醒时长。')
  return { sessionId: sessionId(data.sessionId), minutes }
}

export function submitRequest(input: unknown): SubmitAnswerRequest {
  const data = record(input)
  const target = sessionTarget(data)
  const answer = record(data.answer)
  if (answer.kind === 'unsure') return { ...target, answer: { kind: answer.kind } }
  if (answer.kind === 'multiple-choice') {
    return {
      ...target,
      answer: { kind: answer.kind, optionIndex: integer(answer.optionIndex, 0, 19, '选项无效。') },
    }
  }
  if (
    answer.kind === 'short-answer' &&
    typeof answer.text === 'string' &&
    answer.text.length <= 10_000
  ) {
    return { ...target, answer: { kind: answer.kind, text: answer.text } }
  }
  if (
    answer.kind === 'fill-in' &&
    Array.isArray(answer.values) &&
    answer.values.length <= BANK_LIMITS.maxBlanks
  ) {
    const values = Array.from(answer.values, (value: unknown) => {
      if (typeof value !== 'string' || value.length > BANK_LIMITS.option) invalid('填空答案无效。')
      return value
    })
    return { ...target, answer: { kind: answer.kind, values } }
  }
  if (
    answer.kind === 'ordering' &&
    Array.isArray(answer.order) &&
    answer.order.length <= BANK_LIMITS.maxItems
  ) {
    const order = Array.from(answer.order, (value: unknown) =>
      integer(value, 0, BANK_LIMITS.maxItems - 1, '排序下标无效。'),
    )
    return { ...target, answer: { kind: answer.kind, order } }
  }
  return invalid('答案格式无效。')
}

export function setAnswerFavoriteRequest(input: unknown): SetAnswerFavoriteRequest {
  const value = record(input)
  if (typeof value.favorite !== 'boolean') invalid('收藏状态无效。')
  return { ...sessionTarget(value), favorite: value.favorite }
}

export function rateAnswerRequest(input: unknown): RateAnswerRequest {
  const value = record(input)
  if (typeof value.correct !== 'boolean') invalid('自评结果无效。')
  return { ...sessionTarget(value), correct: value.correct }
}
