import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { QuestionBankRepository } from '../../application/question-bank/service'
import { RequestError } from '../../application/request-error'
import { isBankLanguage } from '../../domain/language'
import type { BankTemplate, Difficulty, Question, QuestionBank } from '../../domain/question'
import type { PracticeSource } from '../../domain/review'
import type { StudyMaterial } from '../../domain/study-material'
import { BANK_LIMITS } from '../../shared/question-bank'
import { REVIEW_SOURCE_JOINS } from './review-sources'
import { writeTransaction } from './transaction'

type Row = Record<string, SQLOutputValue>

export function questionFromRow(row: Row): Question {
  // Variant fields are written through the validated service or migrated from v3.
  const content = JSON.parse(String(row.content_json)) as object
  return {
    ...content,
    id: String(row.id),
    kind: row.kind,
    prompt: String(row.prompt),
    ...(typeof row.difficulty === 'number' ? { difficulty: row.difficulty as Difficulty } : {}),
    ...(typeof row.concept_key === 'string' ? { conceptKey: row.concept_key } : {}),
    ...(typeof row.material_key === 'string' ? { materialKey: row.material_key } : {}),
  } as Question
}

function bankFromRow(row: Row): QuestionBank {
  return {
    id: String(row.id),
    name: String(row.name),
    template: row.template as BankTemplate,
    ...(isBankLanguage(row.language) ? { language: row.language } : {}),
  }
}

function fields(question: Question) {
  const content = {
    ...question,
    id: undefined,
    kind: undefined,
    prompt: undefined,
    difficulty: undefined,
    conceptKey: undefined,
    materialKey: undefined,
  }
  return [
    question.kind,
    question.prompt,
    JSON.stringify(content),
    question.difficulty ?? null,
    question.conceptKey ?? null,
  ] as const
}

export function createQuestionBankRepository(database: DatabaseSync): QuestionBankRepository {
  const listBanks = database.prepare(
    'SELECT id, name, template, language FROM question_banks ORDER BY rowid',
  )
  const getBank = database.prepare(
    'SELECT id, name, template, language FROM question_banks WHERE id = ?',
  )
  const insertBank = database.prepare(
    'INSERT INTO question_banks (id, name, template, language) VALUES (?, ?, ?, ?)',
  )
  const renameBank = database.prepare('UPDATE question_banks SET name = ? WHERE id = ?')
  const deleteBank = database.prepare('DELETE FROM question_banks WHERE id = ?')
  const materialKey = '(SELECT key FROM study_materials WHERE id = q.material_id) AS material_key'
  const listQuestions = database.prepare(
    `SELECT q.id, q.kind, q.prompt, q.content_json, q.difficulty, q.concept_key, ${materialKey}
     FROM questions q WHERE q.bank_id = ? ORDER BY q.rowid`,
  )
  const findMaterial = database.prepare(
    'SELECT id FROM study_materials WHERE bank_id = ? AND key = ?',
  )
  const saveMaterial = database.prepare(`
    INSERT INTO study_materials (bank_id, key, title, explanation, examples_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (bank_id, key) DO UPDATE SET
      title = excluded.title, explanation = excluded.explanation, examples_json = excluded.examples_json
  `)
  database.function('pingo_lower', { deterministic: true }, (value) => String(value).toLowerCase())
  function pageQueries(source: PracticeSource) {
    const from = `FROM questions q ${REVIEW_SOURCE_JOINS[source]}
      WHERE q.bank_id = ? AND (? = '' OR instr(pingo_lower(q.prompt), ?) > 0)`
    const progress = source === 'mistakes' ? ', w.consecutive_correct' : ''
    return {
      count: database.prepare(`SELECT count(*) AS total ${from}`),
      selectPage: database.prepare(
        `SELECT q.id, q.kind, q.prompt, q.content_json, q.difficulty, q.concept_key, ${materialKey}${progress}
         ${from} ORDER BY q.rowid LIMIT ? OFFSET ?`,
      ),
    }
  }
  const pages = {
    all: pageQueries('all'),
    mistakes: pageQueries('mistakes'),
    favorites: pageQueries('favorites'),
  }
  const insertQuestion = database.prepare(
    `INSERT INTO questions (id, bank_id, kind, prompt, content_json, difficulty, concept_key, material_id)
     SELECT ?, id, ?, ?, ?, ?, ?, ? FROM question_banks WHERE id = ?`,
  )
  const updateQuestion = database.prepare(
    'UPDATE questions SET kind = ?, prompt = ?, content_json = ?, difficulty = ?, concept_key = ?, material_id = ? WHERE bank_id = ? AND id = ?',
  )
  const deleteQuestion = database.prepare('DELETE FROM questions WHERE bank_id = ? AND id = ?')
  const removeFavorite = database.prepare(`
    DELETE FROM favorite_questions WHERE question_id = (
      SELECT id FROM questions WHERE bank_id = ? AND id = ?
    )
  `)

  function resolveMaterial(bankId: string, key: string | undefined) {
    if (!key) return null
    const row = findMaterial.get(bankId, key)
    if (!row)
      throw new RequestError('INVALID_ARGUMENTS', `此题库没有学习资料「${key}」。请先导入该资料。`)
    return row.id as number
  }

  function writeContent(
    bankId: string,
    questions: readonly Question[],
    materials: readonly StudyMaterial[],
  ) {
    for (const { key, title, explanation, examples } of materials) {
      saveMaterial.run(bankId, key, title, explanation, JSON.stringify(examples))
    }
    for (const question of questions) {
      insertQuestion.run(
        question.id,
        ...fields(question),
        resolveMaterial(bankId, question.materialKey),
        bankId,
      )
    }
  }

  return {
    listBanks: () => listBanks.all().map(bankFromRow),
    getBank(id) {
      const row = getBank.get(id)
      return row && bankFromRow(row)
    },
    createBank(bank, questions, materials = []) {
      writeTransaction(database, () => {
        insertBank.run(bank.id, bank.name, bank.template, bank.language ?? null)
        writeContent(bank.id, questions, materials)
      })
    },
    appendQuestions(bankId, questions, materials = []) {
      let exists = false
      writeTransaction(database, () => {
        exists = getBank.get(bankId) !== undefined
        if (exists) writeContent(bankId, questions, materials)
      })
      return exists
    },
    renameBank: (bank) => renameBank.run(bank.name, bank.id).changes === 1,
    deleteBank: (id) => deleteBank.run(id).changes === 1,
    listQuestions: (bankId) =>
      getBank.get(bankId) ? listQuestions.all(bankId).map(questionFromRow) : undefined,
    queryQuestions(bankId, query, requestedPage, source) {
      if (!getBank.get(bankId)) return undefined
      const { count, selectPage } = pages[source]
      const total = Number(count.get(bankId, query, query)?.total ?? 0)
      const page = Math.min(requestedPage, Math.max(0, Math.ceil(total / BANK_LIMITS.pageSize) - 1))
      const items = selectPage.all(
        bankId,
        query,
        query,
        BANK_LIMITS.pageSize,
        page * BANK_LIMITS.pageSize,
      )
      return {
        total,
        page,
        items: items.map((row) => ({
          ...questionFromRow(row),
          ...(typeof row.consecutive_correct === 'number'
            ? { reviewSuccesses: row.consecutive_correct }
            : {}),
        })),
      }
    },
    removeFavorite: (bankId, questionId) => {
      removeFavorite.run(bankId, questionId)
    },
    createQuestion: (bankId, question) =>
      insertQuestion.run(
        question.id,
        ...fields(question),
        resolveMaterial(bankId, question.materialKey),
        bankId,
      ).changes === 1,
    updateQuestion: (bankId, question) =>
      updateQuestion.run(
        ...fields(question),
        resolveMaterial(bankId, question.materialKey),
        bankId,
        question.id,
      ).changes === 1,
    deleteQuestion: (bankId, questionId) => deleteQuestion.run(bankId, questionId).changes === 1,
  }
}
