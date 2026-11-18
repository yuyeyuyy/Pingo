import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { QuestionBankRepository } from '../../application/question-bank/service'
import type { Question } from '../../domain/question'
import { writeTransaction } from './transaction'

type Row = Record<string, SQLOutputValue>

export function questionFromRow(row: Row): Question {
  const base = { id: String(row.id), prompt: String(row.prompt) }
  if (row.kind === 'multiple-choice') {
    const options = JSON.parse(String(row.options_json)) as string[]
    return {
      ...base,
      kind: 'multiple-choice',
      options,
      correctOptionIndex: Number(row.correct_option_index),
    }
  }
  return {
    ...base,
    kind: 'short-answer',
    ...(typeof row.reference_answer === 'string' ? { referenceAnswer: row.reference_answer } : {}),
  }
}

function fields(question: Question) {
  if (question.kind === 'multiple-choice') {
    return [
      question.kind,
      question.prompt,
      JSON.stringify(question.options),
      question.correctOptionIndex,
      null,
    ] as const
  }
  return [question.kind, question.prompt, null, null, question.referenceAnswer ?? null] as const
}

export function createQuestionBankRepository(database: DatabaseSync): QuestionBankRepository {
  const listBanks = database.prepare('SELECT id, name FROM question_banks ORDER BY rowid')
  const bankExists = database.prepare('SELECT 1 FROM question_banks WHERE id = ?')
  const insertBank = database.prepare('INSERT INTO question_banks (id, name) VALUES (?, ?)')
  const renameBank = database.prepare('UPDATE question_banks SET name = ? WHERE id = ?')
  const deleteBank = database.prepare('DELETE FROM question_banks WHERE id = ?')
  const listQuestions = database.prepare(
    `SELECT id, kind, prompt, options_json, correct_option_index, reference_answer
     FROM questions WHERE bank_id = ? ORDER BY rowid`,
  )
  const insertQuestion = database.prepare(
    `INSERT INTO questions
       (id, bank_id, kind, prompt, options_json, correct_option_index, reference_answer)
     SELECT ?, id, ?, ?, ?, ?, ? FROM question_banks WHERE id = ?`,
  )
  const updateQuestion = database.prepare(
    `UPDATE questions
     SET kind = ?, prompt = ?, options_json = ?, correct_option_index = ?, reference_answer = ?
     WHERE bank_id = ? AND id = ?`,
  )
  const deleteQuestion = database.prepare('DELETE FROM questions WHERE bank_id = ? AND id = ?')

  return {
    listBanks: () => listBanks.all().map((row) => ({ id: String(row.id), name: String(row.name) })),
    createBank(bank, questions) {
      writeTransaction(database, () => {
        insertBank.run(bank.id, bank.name)
        for (const question of questions)
          insertQuestion.run(question.id, ...fields(question), bank.id)
      })
    },
    renameBank: (bank) => renameBank.run(bank.name, bank.id).changes === 1,
    deleteBank: (id) => deleteBank.run(id).changes === 1,
    listQuestions: (bankId) =>
      bankExists.get(bankId) ? listQuestions.all(bankId).map(questionFromRow) : undefined,
    createQuestion: (bankId, question) =>
      insertQuestion.run(question.id, ...fields(question), bankId).changes === 1,
    updateQuestion: (bankId, question) =>
      updateQuestion.run(...fields(question), bankId, question.id).changes === 1,
    deleteQuestion: (bankId, questionId) => deleteQuestion.run(bankId, questionId).changes === 1,
  }
}
