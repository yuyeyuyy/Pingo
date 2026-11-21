import type { DatabaseSync } from 'node:sqlite'
import type { SQLOutputValue } from 'node:sqlite'
import type { LearningSelection } from '../../application/reminders/learning-engine'
import { isBankLanguage } from '../../domain/language'
import type { LearningStrategy } from '../../domain/progressive-learning'
import type { PracticeSource } from '../../domain/review'
import type { SessionStudyMaterial } from '../../domain/session'
import type { StudyExample } from '../../domain/study-material'
import { REVIEW_SOURCE_JOINS } from './review-sources'

function materialFromRow(row: Record<string, SQLOutputValue>): SessionStudyMaterial {
  return {
    key: String(row.key),
    title: String(row.title),
    explanation: String(row.explanation),
    examples: JSON.parse(String(row.examples_json)) as StudyExample[],
    bankName: String(row.bank_name),
    subject: { bankId: String(row.bank_id), key: String(row.subject_key) },
    ...(isBankLanguage(row.language) ? { language: row.language } : {}),
  }
}

export function createStudyMaterialSource(database: DatabaseSync) {
  const select = database.prepare(`
    SELECT m.key, m.title, m.explanation, m.examples_json, b.name AS bank_name, b.language,
      b.id AS bank_id, pingo_study_subject(b.template, m.title, m.key) AS subject_key
    FROM json_each(?) AS selected
    JOIN questions q ON q.id = selected.value
    JOIN study_materials m ON m.id = q.material_id AND m.bank_id = q.bank_id
    JOIN question_banks b ON b.id = m.bank_id
    GROUP BY m.id
    ORDER BY min(selected.key)
  `)
  return (questionIds: readonly string[]): SessionStudyMaterial[] =>
    select.all(JSON.stringify(questionIds)).map(materialFromRow)
}

export function createStudyMaterialSampler(database: DatabaseSync) {
  const order = 'seen.last_seen_at NULLS FIRST, s.difficulty, s.tie_breaker, s.id'
  function sampler(source: PracticeSource, singleBank: boolean) {
    const bank = singleBank ? 'm.bank_id = :bankId' : '1'
    const sourceFilter =
      source === 'all'
        ? ''
        : `AND EXISTS (
      SELECT 1 FROM questions q ${REVIEW_SOURCE_JOINS[source]}
      WHERE q.material_id = m.id AND q.bank_id = m.bank_id
    )`
    return database.prepare(`
      WITH subjects AS MATERIALIZED (
        SELECT m.id, m.bank_id, pingo_study_subject(b.template, m.title, m.key) AS subject_key,
          CASE WHEN :progressive THEN coalesce((
            SELECT min(q.effective_difficulty) FROM questions q
            WHERE q.material_id = m.id AND q.bank_id = m.bank_id
          ), 1) END AS difficulty,
          CASE WHEN :progressive = 0 THEN random() END AS tie_breaker
        FROM study_materials m JOIN question_banks b ON b.id = m.bank_id
        WHERE ${bank} ${sourceFilter}
      ), candidates AS (
        SELECT s.*, seen.last_seen_at,
          row_number() OVER (PARTITION BY s.bank_id, s.subject_key ORDER BY ${order}) AS variant
        FROM subjects s LEFT JOIN study_material_progress seen ON :progressive
          AND seen.bank_id = s.bank_id AND seen.subject_key = s.subject_key
      ), picked AS (
        SELECT * FROM candidates WHERE variant = 1
        ORDER BY last_seen_at NULLS FIRST, difficulty, tie_breaker, id LIMIT :count
      )
      SELECT m.key, m.title, m.explanation, m.examples_json, b.name AS bank_name, b.language,
        b.id AS bank_id, p.subject_key
      FROM picked p JOIN study_materials m ON m.id = p.id JOIN question_banks b ON b.id = m.bank_id
      ORDER BY p.last_seen_at NULLS FIRST, p.difficulty, p.tie_breaker, p.id
    `)
  }
  const samplers = {
    all: [sampler('all', false), sampler('all', true)],
    mistakes: [sampler('mistakes', false), sampler('mistakes', true)],
    favorites: [sampler('favorites', false), sampler('favorites', true)],
  } as const

  return (count: number, { bankId, source }: LearningSelection, strategy: LearningStrategy) => {
    const index = bankId === null ? 0 : 1
    const parameters = {
      count,
      progressive: Number(strategy === 'progressive'),
      ...(bankId === null ? {} : { bankId }),
    }
    const rows = samplers[source][index].all(parameters)
    return (
      rows.length === 0 && source === 'mistakes' ? samplers.all[index].all(parameters) : rows
    ).map(materialFromRow)
  }
}
