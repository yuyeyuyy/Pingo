import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parseBankAppend, parseQuestionsImport } from '../src/application/question-bank/validation'
import { createQuestionBankService } from '../src/application/question-bank/service'
import { openDatabase } from '../src/infrastructure/database/open'
import { createOptionPartsOfSpeechLookup } from '../src/infrastructure/database/option-parts-of-speech'
import { createQuestionBankRepository } from '../src/infrastructure/database/question-bank-repository'

it('preserves all four question kinds through CLI and language append parsing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pingo-language-cli-'))
  try {
    const questions = [
      {
        kind: 'multiple-choice',
        languageType: 'word-to-meaning',
        prompt: 'apple?',
        options: ['苹果', '梨'],
        correctOptionIndex: 0,
        optionExplanations: ['apple', null],
        optionPartsOfSpeech: ['n', null],
      },
      {
        kind: 'short-answer',
        languageType: 'word-spelling',
        prompt: '苹果的英文？',
        acceptedAnswers: ['apple'],
        referenceAnswer: 'apple',
      },
      {
        kind: 'fill-in',
        languageType: 'grammar-fill-in',
        prompt: 'She {{blank}} a teacher.',
        blanks: [['is']],
      },
      {
        kind: 'ordering',
        languageType: 'sentence-ordering',
        prompt: '排序',
        items: ['apples', 'like', 'I'],
        correctOrder: [2, 1, 0],
      },
    ]
    const input = join(directory, 'input.json')
    const output = join(directory, 'output')
    writeFileSync(input, JSON.stringify({ questions }))
    execFileSync('python3', [
      resolve('scripts/convert_language_bank.py'),
      '--input',
      input,
      '--output',
      output,
    ])
    const json = readFileSync(join(output, 'cet4_language.part001.json'), 'utf8')
    expect(Object.keys(JSON.parse(json))).toEqual(['questions'])
    expect(parseQuestionsImport(json, 'language')).toEqual(
      questions.map((question, index) => ({ ...question, difficulty: [1, 2, 2, 1][index] })),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('recovers option parts of speech for legacy vocabulary using the same word and definition', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pingo-language-legacy-'))
  const database = openDatabase(directory)
  try {
    const banks = createQuestionBankService(createQuestionBankRepository(database), randomUUID)
    const { id: bankId } = banks.createBank({ name: '旧词表', template: 'language' })
    banks.appendQuestionImport({
      bankId,
      json: JSON.stringify({
        questions: [
          {
            kind: 'multiple-choice',
            languageType: 'meaning-to-word',
            prompt: '哪个单词表示「又一次」？',
            options: ['again', 'already', 'quiet'],
            optionExplanations: ['又一次', '早已', '安静的'],
            correctOptionIndex: 0,
            conceptKey: 'again:adv:repeat',
          },
          {
            kind: 'multiple-choice',
            languageType: 'word-to-meaning',
            prompt: 'already 的意思是什么？',
            options: ['早已', '安静的'],
            optionExplanations: ['already', 'quiet'],
            correctOptionIndex: 0,
            conceptKey: 'already:adv:before-now',
          },
          {
            kind: 'multiple-choice',
            languageType: 'word-to-meaning',
            prompt: 'quiet 作为名词怎么解释？',
            options: ['安静状态', '早已'],
            optionExplanations: ['quiet', 'already'],
            correctOptionIndex: 0,
            conceptKey: 'quiet:n:stillness',
          },
        ],
      }),
    })
    const [legacy] = banks.listQuestions({ bankId })
    expect(createOptionPartsOfSpeechLookup(database)(legacy!, bankId)).toMatchObject({
      optionPartsOfSpeech: ['adv', 'adv', null],
    })
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

const cet4Study = resolve('data/cet4-study')
const cet4StudyReport = join(cet4Study, 'conversion_report.json')

it.skipIf(!existsSync(cet4StudyReport))(
  'appends all real converted questions to a temporary language bank and preserves existing content',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'pingo-language-real-'))
    const database = openDatabase(directory)
    try {
      const report = JSON.parse(readFileSync(cet4StudyReport, 'utf8')) as {
        input_records: number
        converted_records: number
        output_questions: number
        skipped_records: number
        learning_materials: { unique_exported: number; linked_questions: number }
        skipped: { source_number: number }[]
        files: { path: string; questions: number; bytes: number }[]
      }
      expect(report.input_records).toBe(report.converted_records + report.skipped_records)
      const banks = createQuestionBankService(createQuestionBankRepository(database), randomUUID)
      const bank = banks.createBank({ name: '语言学习测试', template: 'language' })
      const existing = banks.createQuestion({
        bankId: bank.id,
        question: { kind: 'short-answer', prompt: '已有问题', referenceAnswer: '已有答案' },
      })
      const expected = []
      for (const file of report.files) {
        const json = readFileSync(join(cet4Study, file.path.split('/').at(-1)!), 'utf8')
        const { questions, materials } = parseBankAppend(json, 'language')
        expect(materials).toHaveLength(report.learning_materials.unique_exported)
        expect(new Set(questions.map((q) => q.materialKey))).toEqual(
          new Set(materials.map((m) => m.key)),
        )
        expect(Buffer.byteLength(json)).toBe(file.bytes)
        expect(file.bytes).toBeLessThanOrEqual(32 * 1024 * 1024)
        expect(questions).toHaveLength(file.questions)
        expect(questions.every((q) => q.difficulty !== undefined)).toBe(true)
        expect(questions.length).toBeGreaterThan(0)
        expected.push(...questions)
        expect(banks.appendQuestionImport({ bankId: bank.id, json })).toEqual({
          added: questions.length,
          materials: materials.length,
        })
      }
      expect(new Set(expected.map((q) => q.languageType))).toEqual(
        new Set(['word-spelling', 'word-to-meaning', 'meaning-to-word']),
      )
      for (const q of expected) {
        if (q.kind === 'multiple-choice') {
          expect(q.optionExplanations).toHaveLength(q.options.length)
          expect(q.optionExplanations?.every(Boolean)).toBe(true)
        }
      }
      expect(database.prepare('SELECT COUNT(*) AS n FROM study_materials').get()?.n).toBe(
        report.learning_materials.unique_exported,
      )
      expect(expected.filter((q) => q.materialKey)).toHaveLength(
        report.learning_materials.linked_questions,
      )
      const stored = banks.listQuestions({ bankId: bank.id })
      const legacy = stored.find(
        (question) => question.prompt === '以下哪个单词表示「又一次」（副词）？',
      )
      expect(legacy).toBeDefined()
      expect(createOptionPartsOfSpeechLookup(database)(legacy!, bank.id)).toMatchObject({
        options: ['specifically', 'fundamentally', 'again', 'already'],
        optionPartsOfSpeech: ['adv', 'adv', 'adv', 'adv'],
      })
      expect(stored[0]).toEqual(existing)
      expect(
        stored
          .slice(1)
          .map((q) => Object.fromEntries(Object.entries(q).filter(([key]) => key !== 'id'))),
      ).toEqual(expected)
      expect(stored).toHaveLength(report.output_questions + 1)
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
