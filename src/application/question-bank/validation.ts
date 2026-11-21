import {
  BANK_TEMPLATES,
  BLANK_MARKER,
  isPermutation,
  LANGUAGE_QUESTION_TYPES,
} from '../../domain/question'
import type {
  BankTemplate,
  Difficulty,
  LanguageQuestionType,
  QuestionDraft,
} from '../../domain/question'
import { PRACTICE_SOURCES } from '../../domain/review'
import type { PracticeSource } from '../../domain/review'
import type { StudyMaterial } from '../../domain/study-material'
import { normalizePartOfSpeech } from '../../domain/part-of-speech'
import { DEFAULT_BANK_LANGUAGE, isBankLanguage } from '../../domain/language'
import type { BankLanguage } from '../../domain/language'
import { BANK_LIMITS } from '../../shared/question-bank'
import { RequestError } from '../request-error'

export class QuestionBankError extends RequestError {}

function invalid(message: string): never {
  throw new QuestionBankError('INVALID_ARGUMENTS', message)
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid('请提供有效的对象。')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`请填写${label}。`)
  const trimmed = value.trim()
  if (trimmed.includes('\0')) invalid(`${label}包含无效字符。`)
  if (trimmed.length > max) invalid(`${label}不能超过 ${max} 个字符。`)
  return trimmed
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined || (typeof value === 'string' && !value.trim())
    ? undefined
    : text(value, label, max)
}

function normalizedKey(value: unknown, label: string, max: number): string {
  return text(
    typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ') : value,
    label,
    max,
  )
}

export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    invalid('记录标识无效。')
  return value
}

export function bankName(value: unknown): string {
  return text(value, '题库名称', BANK_LIMITS.name)
}

export function bankTemplate(value: unknown): BankTemplate {
  if (value === undefined) return 'basic'
  if (typeof value !== 'string' || !Object.hasOwn(BANK_TEMPLATES, value))
    invalid('请选择有效的题库模板。')
  return value as BankTemplate
}

export function bankLanguage(template: BankTemplate, value: unknown): BankLanguage | undefined {
  if (template !== 'language') {
    if (value !== undefined) invalid('请为语言学习模板选择语言。')
    return undefined
  }
  // Existing callers of createBank previously omitted the language.
  if (value === undefined) return DEFAULT_BANK_LANGUAGE
  if (!isBankLanguage(value)) invalid('请选择有效的题库语言。')
  return value
}

function languageCategory(
  value: unknown,
  kind: unknown,
  template: BankTemplate,
): LanguageQuestionType | undefined {
  if (value === undefined) return undefined
  if (template !== 'language') invalid('语言分类需要导入语言学习题库。')
  if (typeof value !== 'string' || !Object.hasOwn(LANGUAGE_QUESTION_TYPES, value))
    invalid('语言题型无效。')
  const category = value as LanguageQuestionType
  if (LANGUAGE_QUESTION_TYPES[category].kind !== kind) invalid('语言题型与答题方式不匹配。')
  return category
}

function array(value: unknown, min: number, max: number, message: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(message)
  return Array.from(value as unknown[])
}

function list(value: unknown, label: string, min: number, max: number, textMax: number): string[] {
  return array(value, min, max, `${label}需要 ${min} 至 ${max} 项。`).map((item, index) =>
    text(item, `${label} ${index + 1}`, textMax),
  )
}

export function questionDraft(value: unknown, template: BankTemplate = 'basic'): QuestionDraft {
  const data = object(value)
  const kind = data.kind
  const languageType = languageCategory(data.languageType, kind, template)
  const prompt = text(data.prompt, '题干', BANK_LIMITS.prompt)
  const difficulty = data.difficulty
  if (
    difficulty !== undefined &&
    (typeof difficulty !== 'number' ||
      !Number.isInteger(difficulty) ||
      difficulty < 1 ||
      difficulty > 5)
  )
    invalid('难度必须为 1 至 5 的整数。')
  const conceptKey =
    data.conceptKey === undefined
      ? undefined
      : normalizedKey(data.conceptKey, '知识点分组', BANK_LIMITS.conceptKey)
  const materialKey =
    data.materialKey === undefined
      ? undefined
      : normalizedKey(data.materialKey, '学习资料标识', BANK_LIMITS.materialKey)
  const base = {
    prompt,
    ...(languageType === undefined ? {} : { languageType }),
    ...(difficulty === undefined ? {} : { difficulty: difficulty as Difficulty }),
    ...(conceptKey === undefined ? {} : { conceptKey }),
    ...(materialKey === undefined ? {} : { materialKey }),
  }

  switch (kind) {
    case 'short-answer': {
      const referenceAnswer = optionalText(
        data.referenceAnswer,
        '参考答案',
        BANK_LIMITS.referenceAnswer,
      )
      const acceptedAnswers =
        data.acceptedAnswers === undefined
          ? undefined
          : list(
              data.acceptedAnswers,
              '可接受答案',
              1,
              BANK_LIMITS.maxOptions,
              BANK_LIMITS.referenceAnswer,
            )
      if (languageType && !acceptedAnswers) invalid('此语言填写题需要至少一个可接受答案。')
      return {
        ...base,
        kind,
        ...(referenceAnswer === undefined ? {} : { referenceAnswer }),
        ...(acceptedAnswers === undefined ? {} : { acceptedAnswers }),
      }
    }
    case 'fill-in': {
      const blankCount = prompt.split(BLANK_MARKER).length - 1
      if (blankCount < 1 || blankCount > BANK_LIMITS.maxBlanks)
        invalid(`题干需包含 1 至 ${BANK_LIMITS.maxBlanks} 个 ${BLANK_MARKER}。`)
      const blanks = array(
        data.blanks,
        blankCount,
        blankCount,
        '填空答案数量必须与题干中的空格数量一致。',
      ).map((answers, index) =>
        list(answers, `第 ${index + 1} 空的答案`, 1, BANK_LIMITS.maxOptions, BANK_LIMITS.option),
      )
      return { ...base, kind, blanks }
    }
    case 'ordering': {
      const items = list(data.items, '排序条目', 2, BANK_LIMITS.maxItems, BANK_LIMITS.option)
      if (new Set(items).size < 2) invalid('排序题需要至少两个不同的条目。')
      const order = array(data.correctOrder, items.length, items.length, '正确顺序须包含所有条目。')
      if (!isPermutation(order, items.length))
        invalid('正确顺序必须是从 0 开始且无重复的条目下标。')
      return { ...base, kind, items, correctOrder: order }
    }
    case 'multiple-choice': {
      const headword =
        languageType === 'word-to-meaning'
          ? optionalText(data.headword, '题干单词', BANK_LIMITS.headword)
          : undefined
      if (headword && !prompt.toLowerCase().includes(headword.toLowerCase()))
        invalid('题干单词须出现在题干中。')
      const options = list(
        data.options,
        '选项',
        BANK_LIMITS.minOptions,
        BANK_LIMITS.maxOptions,
        BANK_LIMITS.option,
      )
      const correct = data.correctOptionIndex
      if (
        typeof correct !== 'number' ||
        !Number.isInteger(correct) ||
        correct < 0 ||
        correct >= options.length
      ) {
        invalid('请选择一个有效的正确选项。')
      }
      const optionExplanations =
        data.optionExplanations === undefined
          ? undefined
          : array(
              data.optionExplanations,
              options.length,
              options.length,
              '选项释义数量必须与选项一致。',
            ).map((item, index) =>
              item === null
                ? null
                : (optionalText(item, `选项 ${index + 1} 的释义`, BANK_LIMITS.option) ?? null),
            )
      const optionPartsOfSpeech =
        data.optionPartsOfSpeech === undefined
          ? undefined
          : array(
              data.optionPartsOfSpeech,
              options.length,
              options.length,
              '选项词性数量必须与选项一致。',
            ).map((item, index) => {
              if (item === null) return null
              const part = typeof item === 'string' && normalizePartOfSpeech(item)
              if (!part) invalid(`第 ${index + 1} 个选项的词性无效。`)
              return part
            })
      return {
        ...base,
        kind,
        options,
        correctOptionIndex: correct,
        ...(headword === undefined ? {} : { headword }),
        ...(optionExplanations === undefined ? {} : { optionExplanations }),
        ...(optionPartsOfSpeech === undefined ? {} : { optionPartsOfSpeech }),
      }
    }
    default:
      return invalid('题型无效。')
  }
}

function importDocument(json: unknown): Record<string, unknown> {
  if (
    typeof json !== 'string' ||
    json.length > BANK_LIMITS.importBytes ||
    new TextEncoder().encode(json).byteLength > BANK_LIMITS.importBytes
  ) {
    invalid('请提供不超过 32 MiB 的 JSON 文件。')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json.replace(/^\uFEFF/, ''))
  } catch {
    invalid('文件内容不是有效的 JSON。')
  }
  return object(parsed)
}

function importQuestions(input: unknown, template: BankTemplate): QuestionDraft[] {
  if (!Array.isArray(input) || input.length === 0) invalid('导入文件需包含至少一道题。')
  return input.map((item: unknown, index) => {
    try {
      return questionDraft(item, template)
    } catch (error) {
      if (!(error instanceof QuestionBankError)) throw error
      invalid(`第 ${index + 1} 题：${error.message}`)
    }
  })
}

export function parseQuestionsImport(json: unknown, template: BankTemplate): QuestionDraft[] {
  return parseBankAppend(json, template).questions
}

function parseQuestionContent(
  { questions, materials }: Record<string, unknown>,
  template: BankTemplate,
): { questions: QuestionDraft[]; materials: StudyMaterial[] } {
  const entries: StudyMaterial[] = []
  if (materials !== undefined) {
    if (!Array.isArray(materials)) invalid('学习资料需要使用 materials 数组。')
    const keys = new Set<string>()
    for (const [index, item] of materials.entries()) {
      try {
        const data = object(item)
        const key = normalizedKey(data.key, '学习资料标识', BANK_LIMITS.materialKey)
        if (keys.has(key)) invalid(`学习资料标识「${key}」在同一文件中重复。`)
        keys.add(key)
        const title = text(data.title, '资料标题', BANK_LIMITS.materialTitle)
        const explanation = text(data.explanation, '资料讲解', BANK_LIMITS.referenceAnswer)
        const examples =
          data.examples === undefined
            ? []
            : array(
                data.examples,
                0,
                BANK_LIMITS.maxExamples,
                `每份资料最多 ${BANK_LIMITS.maxExamples} 条例子。`,
              ).map((example) => {
                const data = object(example)
                const exampleText = text(data.text, '例句或示例', BANK_LIMITS.option)
                const translation = optionalText(data.translation, '示例译文', BANK_LIMITS.option)
                return { text: exampleText, ...(translation ? { translation } : {}) }
              })
        entries.push({ key, title, explanation, examples })
      } catch (error) {
        if (!(error instanceof QuestionBankError)) throw error
        invalid(`第 ${index + 1} 份学习资料：${error.message}`)
      }
    }
  }
  const drafts =
    entries.length > 0 &&
    (questions === undefined || (Array.isArray(questions) && !questions.length))
      ? []
      : importQuestions(questions, template)
  return { questions: drafts, materials: entries }
}

export function parseBankAppend(json: unknown, template: BankTemplate) {
  return parseQuestionContent(importDocument(json), template)
}

export function parseBankImport(json: unknown) {
  const document = importDocument(json)
  const name = bankName(document.name)
  const { questions, materials } = parseQuestionContent(document, 'basic')
  return { name, questions, ...(materials.length ? { materials } : {}) }
}

export function questionPage(input: unknown) {
  const { bankId, query, page, source = 'all' } = object(input)
  const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / BANK_LIMITS.pageSize) - 1
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page > maxPage)
    invalid('页码无效。')
  if (typeof query !== 'string' || query.length > BANK_LIMITS.prompt) invalid('搜索词无效。')
  if (typeof source !== 'string' || !Object.hasOwn(PRACTICE_SOURCES, source))
    invalid('题目来源无效。')
  return {
    bankId: id(bankId),
    query: query.trim().toLowerCase(),
    page,
    source: source as PracticeSource,
  }
}
