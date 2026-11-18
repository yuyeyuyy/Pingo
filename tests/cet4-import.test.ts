import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { parseBankImport } from '../src/application/question-bank/validation'
import { createQuestionBankService } from '../src/application/question-bank/service'
import { openDatabase } from '../src/infrastructure/database/open'
import { createQuestionBankRepository } from '../src/infrastructure/database/question-bank-repository'

const minimalSource = resolve('data/cet4-new/cet4_all.json')
const minimalOutput = resolve('data/cet4-import')
const cet4Output = resolve('data/cet4')
const cet4Report = join(cet4Output, 'cet4_report.json')

it('converts vocabulary with Python and passes the existing Pingo importer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pingo-vocabulary-'))
  try {
    const input = join(directory, 'source.json')
    const output = join(directory, 'banks')
    writeFileSync(
      input,
      JSON.stringify(
        [
          ['apple', '苹果'],
          ['desk', '书桌'],
          ['cloud', '云朵'],
          ['river', '河流'],
          ['music', '音乐'],
          ['shoe', '鞋子'],
        ].map(([word, translation]) => ({ word, translations: [{ translation, type: 'n' }] })),
      ),
    )
    execFileSync(
      'python3',
      [
        resolve('scripts/convert_vocabulary.py'),
        '--input',
        input,
        '--output',
        output,
        '--seed',
        '42',
      ],
      { encoding: 'utf8' },
    )
    const bank = parseBankImport(readFileSync(join(output, 'cet4_all.json'), 'utf8'))
    expect(bank.questions).toHaveLength(12)
    expect(
      bank.questions.every((q) => q.kind === 'multiple-choice' && q.options.length === 4),
    ).toBe(true)
    const minimalOutput = join(directory, 'minimal')
    execFileSync(
      'python3',
      [
        resolve('scripts/convert_vocabulary.py'),
        '--from-bank',
        '--input',
        output,
        '--output',
        minimalOutput,
      ],
      { encoding: 'utf8' },
    )
    const minimalJson = readFileSync(join(minimalOutput, 'cet4_import.part001.json'), 'utf8')
    expect(parseBankImport(minimalJson).questions).toEqual(bank.questions)
    expect(Object.keys(JSON.parse(minimalJson))).toEqual(['name', 'questions'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.skipIf(!existsSync(minimalSource) || !existsSync(minimalOutput))(
  'imports the minimal files and preserves all 8084 source questions in order',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'pingo-minimal-import-'))
    const database = openDatabase(directory)
    try {
      const source = parseBankImport
      // The combined source exceeds the importer size/count limits, so parse its JSON directly.
      const original = JSON.parse(readFileSync(minimalSource, 'utf8'))
      const expected = original.questions.map((q: Record<string, unknown>) => ({
        kind: q.kind,
        prompt: q.prompt,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
      }))
      const output = minimalOutput
      const files = readdirSync(output)
        .filter((n) => /^cet4_import\.part\d+\.json$/.test(n))
        .sort()
      const questions = []
      const banks = createQuestionBankService(createQuestionBankRepository(database), randomUUID)
      let imported = 0
      for (const filename of files) {
        const json = readFileSync(join(output, filename), 'utf8')
        const raw = JSON.parse(json)
        expect(Object.keys(raw)).toEqual(['name', 'questions'])
        for (const q of raw.questions) {
          expect(Object.keys(q)).toEqual(['kind', 'prompt', 'options', 'correctOptionIndex'])
        }
        questions.push(...source(json).questions)
        const bank = banks.importQuestionBank(json)
        imported += banks.listQuestions({ bankId: bank.id }).length
      }
      expect(questions).toEqual(expected)
      expect(imported).toBe(8084)
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

it.skipIf(!existsSync(cet4Report))(
  'imports all real CET4 combined shards into an isolated temporary database',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'pingo-cet4-import-'))
    const database = openDatabase(directory)
    try {
      const output = cet4Output
      const report = JSON.parse(readFileSync(cet4Report, 'utf8')) as {
        direct_import_files: string[]
        total_questions: number
      }
      const banks = createQuestionBankService(createQuestionBankRepository(database), randomUUID)
      let imported = 0
      for (const filename of report.direct_import_files) {
        // Validate every direction's importable file through production code.
        const json = readFileSync(join(output, filename), 'utf8')
        const parsed = parseBankImport(json)
        expect(parsed.questions.length).toBeGreaterThan(0)
        if (filename.startsWith('cet4_all')) {
          const bank = banks.importQuestionBank(json)
          imported += banks.listQuestions({ bankId: bank.id }).length
        }
      }
      expect(imported).toBe(report.total_questions)
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
