import type { DatabaseSync } from 'node:sqlite'
import type { LearningSelection } from '../../application/reminders/learning-engine'
import type { ReminderState, ReminderStore } from '../../application/reminders/scheduler'
import { REVIEW_SUCCESSES } from '../../domain/review'
import { isBankLanguage } from '../../domain/language'
import type { PracticeSource } from '../../domain/review'
import { createOptionPartsOfSpeechLookup } from './option-parts-of-speech'
import { createLearningProgressWriter } from './progressive-learning'
import { questionFromRow } from './question-bank-repository'
import { REVIEW_SOURCE_JOINS } from './review-sources'
import { writeTransaction } from './transaction'

export function createReminderStore(database: DatabaseSync): ReminderStore {
  const learning = createLearningProgressWriter(database)
  const load = database.prepare('SELECT payload FROM reminder_state WHERE singleton = 1')
  const save = database.prepare(`
    INSERT INTO reminder_state VALUES (1, ?)
    ON CONFLICT (singleton) DO UPDATE SET payload = excluded.payload
  `)
  const history = database.prepare(`
    INSERT INTO learning_history (session_id, ended_at, outcome, payload) VALUES (?, ?, ?, ?)
  `)
  const rememberStudyMaterial = database.prepare(`
    INSERT INTO study_material_progress (bank_id, subject_key, last_seen_at)
    SELECT id, ?, ? FROM question_banks WHERE id = ?
    ON CONFLICT (bank_id, subject_key) DO UPDATE SET
      last_seen_at = max(study_material_progress.last_seen_at, excluded.last_seen_at)
  `)
  const questionExists = database.prepare('SELECT 1 FROM questions WHERE id = ?')
  const favoriteExists = database.prepare('SELECT 1 FROM favorite_questions WHERE question_id = ?')
  const addFavorite = database.prepare(
    'INSERT OR IGNORE INTO favorite_questions (question_id) VALUES (?)',
  )
  const removeFavorite = database.prepare('DELETE FROM favorite_questions WHERE question_id = ?')
  const recordWrong = database.prepare(`
    INSERT INTO wrong_questions (question_id, consecutive_correct)
    SELECT id, 0 FROM questions WHERE id = ?
    ON CONFLICT (question_id) DO UPDATE SET consecutive_correct = 0
  `)
  const graduate = database.prepare(
    'DELETE FROM wrong_questions WHERE question_id = ? AND consecutive_correct >= ?',
  )
  const recordSuccess = database.prepare(
    'UPDATE wrong_questions SET consecutive_correct = consecutive_correct + 1 WHERE question_id = ?',
  )

  return {
    load() {
      const row = load.get()
      return row ? (JSON.parse(String(row.payload)) as ReminderState) : undefined
    },
    save(state, { ended, review, studySeen } = {}) {
      const payload = JSON.stringify(state)
      if (!ended && !studySeen && (!review || review.outcome === 'ungraded')) {
        save.run(payload)
        return
      }
      writeTransaction(database, () => {
        if (studySeen) rememberStudyMaterial.run(studySeen.key, studySeen.at, studySeen.bankId)
        if (ended) {
          history.run(ended.session.id, ended.at, ended.outcome, JSON.stringify(ended.session))
        }
        if (review?.outcome === 'incorrect') recordWrong.run(review.questionId)
        if (
          review?.outcome === 'correct' &&
          graduate.run(review.questionId, REVIEW_SUCCESSES - 1).changes === 0
        ) {
          recordSuccess.run(review.questionId)
        }
        if (review) learning.recordAttempt(review)
        if (ended?.outcome === 'completed') learning.recordCompleted(ended.session)
        save.run(payload)
      })
    },
    isFavorite: (questionId) => favoriteExists.get(questionId) !== undefined,
    setFavorite(questionId, favorite) {
      if (!questionExists.get(questionId)) return false
      if (favorite) addFavorite.run(questionId)
      else removeFavorite.run(questionId)
      return true
    },
  }
}

export function createLearningQuestionSource(database: DatabaseSync) {
  const withPartsOfSpeech = createOptionPartsOfSpeechLookup(database)
  function sampler(source: PracticeSource, singleBank: boolean) {
    const join = REVIEW_SOURCE_JOINS[source]
    const bankFilter = singleBank ? 'q.bank_id = ?' : '1'
    const questions = `
      SELECT q.id, q.kind, q.prompt, q.content_json, q.difficulty, q.concept_key, q.bank_id,
        b.name AS bank_name, b.language AS bank_language
      FROM questions q JOIN question_banks b ON b.id = q.bank_id
    `
    return {
      practice: database.prepare(
        `${questions} ${join} WHERE ${bankFilter} ORDER BY random() LIMIT ?`,
      ),
      study: database.prepare(`
        WITH variants AS (
          SELECT q.id, seen.last_seen_at, row_number() OVER (
            PARTITION BY q.bank_id, pingo_study_subject(b.template, m.title, m.key) ORDER BY random()
          ) AS rank
          FROM questions q ${join}
          JOIN study_materials m ON m.id = q.material_id
          JOIN question_banks b ON b.id = q.bank_id
          LEFT JOIN study_material_progress seen ON seen.bank_id = q.bank_id
            AND seen.subject_key = pingo_study_subject(b.template, m.title, m.key)
          WHERE ${bankFilter}
        )
        ${questions}
        WHERE q.id IN (
          SELECT id FROM variants WHERE rank = 1 ORDER BY last_seen_at NULLS FIRST, random() LIMIT ?
        )
        ORDER BY random()
      `),
    }
  }
  const samplers = {
    all: [sampler('all', false), sampler('all', true)],
    mistakes: [sampler('mistakes', false), sampler('mistakes', true)],
    favorites: [sampler('favorites', false), sampler('favorites', true)],
  } as const

  return (count: number, selection: LearningSelection = { bankId: null, source: 'all' }) => {
    const { bankId, source, requiresMaterial } = selection
    const statements = samplers[source][bankId === null ? 0 : 1]
    const sample = requiresMaterial ? statements.study : statements.practice
    const rows = bankId === null ? sample.all(count) : sample.all(bankId, count)
    return rows.map((row) => ({
      ...withPartsOfSpeech(questionFromRow(row), String(row.bank_id)),
      bankName: String(row.bank_name),
      ...(isBankLanguage(row.bank_language) ? { language: row.bank_language } : {}),
    }))
  }
}
