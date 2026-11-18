import type { QuestionDraft } from '../../domain/question'
import { BANK_LIMITS } from '../../shared/question-bank'

import { RequestError } from '../request-error'

export class QuestionBankError extends RequestError {}

function invalid(message: string): never {
  throw new QuestionBankError('INVALID_ARGUMENTS', message)
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('请提供有效的对象。')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`请填写${label}。`)
  const trimmed = value.trim()
  if (trimmed.includes('\0')) invalid(`${label}包含无效字符。`)
  if (trimmed.length > max) invalid(`${label}不能超过 ${max} 个字符。`)
  return trimmed
}

export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) {
    invalid('记录标识无效。')
  }
  return value
}

export function bankName(value: unknown): string {
  return text(value, '题库名称', BANK_LIMITS.name)
}

export function questionDraft(value: unknown): QuestionDraft {
  const { kind, prompt, options, correctOptionIndex, referenceAnswer } = object(value)
  const normalizedPrompt = text(prompt, '题干', BANK_LIMITS.prompt)

  if (kind === 'short-answer') {
    const answer =
      typeof referenceAnswer === 'string' && !referenceAnswer.trim() ? undefined : referenceAnswer
    return {
      kind,
      prompt: normalizedPrompt,
      ...(answer === undefined
        ? {}
        : { referenceAnswer: text(answer, '参考答案', BANK_LIMITS.referenceAnswer) }),
    }
  }

  if (kind !== 'multiple-choice') invalid('题型必须是 multiple-choice 或 short-answer。')
  if (
    !Array.isArray(options) ||
    options.length < BANK_LIMITS.minOptions ||
    options.length > BANK_LIMITS.maxOptions
  ) {
    invalid(`选择题需填写 ${BANK_LIMITS.minOptions} 至 ${BANK_LIMITS.maxOptions} 个选项。`)
  }
  const normalizedOptions = Array.from(options, (option: unknown, index) =>
    text(option, `选项 ${index + 1}`, BANK_LIMITS.option),
  )
  if (
    typeof correctOptionIndex !== 'number' ||
    !Number.isInteger(correctOptionIndex) ||
    correctOptionIndex < 0 ||
    correctOptionIndex >= normalizedOptions.length
  ) {
    invalid('请选择一个有效的正确选项。')
  }
  return { kind, prompt: normalizedPrompt, options: normalizedOptions, correctOptionIndex }
}

export function parseBankImport(json: unknown): { name: string; questions: QuestionDraft[] } {
  if (
    typeof json !== 'string' ||
    json.length > BANK_LIMITS.importBytes ||
    new TextEncoder().encode(json).byteLength > BANK_LIMITS.importBytes
  ) {
    invalid('请提供不超过 4 MiB 的 JSON 文件。')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json.replace(/^\uFEFF/, ''))
  } catch {
    invalid('文件内容不是有效的 JSON。')
  }

  const { name, questions } = object(parsed)
  const normalizedName = bankName(name)
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > BANK_LIMITS.importQuestions
  ) {
    invalid(`导入文件需包含 1 至 ${BANK_LIMITS.importQuestions} 道题。`)
  }
  const normalizedQuestions = questions.map((item: unknown, index) => {
    try {
      return questionDraft(item)
    } catch (error) {
      if (!(error instanceof QuestionBankError)) throw error
      invalid(`第 ${index + 1} 题：${error.message}`)
    }
  })
  return { name: normalizedName, questions: normalizedQuestions }
}
