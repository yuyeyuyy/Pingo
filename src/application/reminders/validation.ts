import { PAUSE_OPTIONS, SNOOZE_MINUTES } from '../../domain/scheduling'
import type { PauseOption, ReminderSettings } from '../../domain/scheduling'
import type { SessionTarget } from '../../domain/session'
import type { SubmitAnswerRequest } from '../../shared/reminders'
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
    questionsPerSession: integer(input.questionsPerSession, 1, 20, '每次题量须为 1 至 20 道。'),
    mode,
    focusPopup: flag(input.focusPopup),
    avoidFullscreen: flag(input.avoidFullscreen),
    avoidIdle: flag(input.avoidIdle),
    quietHours,
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
  return invalid('答案格式无效。')
}
