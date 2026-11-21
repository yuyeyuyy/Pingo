import type { DatabaseSync } from 'node:sqlite'
import { isBankLanguage } from '../../domain/language'
import { createOptionPartsOfSpeechLookup } from './option-parts-of-speech'
import type { LearningEngine, LearningSelection } from '../../application/reminders/learning-engine'
import {
  afterGradedAnswer,
  availableLevel,
  calibrate,
  CHALLENGE_CORRECT,
  CHALLENGE_SAMPLES,
  chooseProgressiveRound,
  chooseStudyRound,
} from '../../domain/progressive-learning'
import type {
  CalibrationSample,
  LearningCandidate,
  LearningProfile,
} from '../../domain/progressive-learning'
import type { Difficulty } from '../../domain/question'
import type { PracticeSource, ReviewAttempt } from '../../domain/review'
import type { LearningSession } from '../../domain/session'
import { questionFromRow } from './question-bank-repository'
import { REVIEW_SOURCE_JOINS } from './review-sources'

function profiles(database: DatabaseSync) {
  const saved = database.prepare(
    'SELECT level, epoch, samples_json FROM bank_learning_profiles WHERE bank_id = ?',
  )
  const levels = database.prepare(
    'SELECT DISTINCT effective_difficulty FROM questions WHERE bank_id = ? ORDER BY effective_difficulty',
  )
  return {
    read(bankId: string) {
      const stored = saved.get(bankId)
      const available = levels.all(bankId).map((row) => row.effective_difficulty as Difficulty)
      const level = availableLevel(available, stored?.level as Difficulty | undefined)
      const profile: LearningProfile | undefined =
        level === undefined
          ? undefined
          : {
              level,
              epoch: Number(stored?.epoch ?? 0),
              samples:
                stored && stored.level === level
                  ? (JSON.parse(String(stored.samples_json)) as CalibrationSample[])
                  : [],
            }
      return { available, profile }
    },
  }
}

export function createLearningEngine(database: DatabaseSync): LearningEngine {
  const { read } = profiles(database)
  const withPartsOfSpeech = createOptionPartsOfSpeechLookup(database)
  const question = database.prepare(`
    SELECT q.id, q.kind, q.prompt, q.content_json, q.difficulty, q.concept_key,
      b.name AS bank_name, b.language AS bank_language
    FROM questions q JOIN question_banks b ON b.id = q.bank_id WHERE q.id = ?
  `)

  function queries(source: PracticeSource, singleBank: boolean) {
    const join = REVIEW_SOURCE_JOINS[source]
    const scope = `(:study = 0 OR q.material_id IS NOT NULL)${singleBank ? ' AND q.bank_id = :bankId' : ''}`
    return {
      exists: database.prepare(`SELECT 1 FROM questions q ${join} WHERE ${scope} LIMIT 1`),
      due: database.prepare(`
        SELECT
          (SELECT count(*) FROM question_learning l
            JOIN questions q ON q.id = l.question_id ${join}
            WHERE l.due_at <= :now AND ${scope})
          + (SELECT count(*) FROM wrong_questions legacy
            JOIN questions q ON q.id = legacy.question_id ${join}
            WHERE ${scope} AND NOT EXISTS
              (SELECT 1 FROM question_learning l WHERE l.question_id = q.id)) AS count
      `),
      pick: database.prepare(`
        WITH scoped AS MATERIALIZED (
          SELECT q.id, q.bank_id, q.effective_difficulty AS difficulty,
                 CASE WHEN :study = 0 THEN q.concept_key END AS concept_key,
                 CASE WHEN :study = 1 THEN pingo_study_subject(b.template, m.title, m.key) END AS subject_key,
                 seen.last_seen_at,
                 q.rowid AS ordinal, l.due_at, legacy.question_id IS NOT NULL AS was_wrong
          FROM questions q ${join}
          LEFT JOIN question_learning l ON l.question_id = q.id
          LEFT JOIN wrong_questions legacy ON legacy.question_id = q.id AND l.question_id IS NULL
          LEFT JOIN study_materials m ON :study = 1 AND m.id = q.material_id
          LEFT JOIN question_banks b ON :study = 1 AND b.id = q.bank_id
          LEFT JOIN study_material_progress seen ON :study = 1 AND seen.bank_id = q.bank_id
            AND seen.subject_key = pingo_study_subject(b.template, m.title, m.key)
          WHERE ${scope}
        ), pool_levels AS (
          SELECT s.bank_id,
            coalesce(max(CASE WHEN s.difficulty <= p.level THEN s.difficulty END), min(s.difficulty)) AS level,
            p.level AS saved_level, coalesce(p.epoch, 0) AS epoch, p.samples_json
          FROM scoped s LEFT JOIN bank_learning_profiles p ON p.bank_id = s.bank_id
          GROUP BY s.bank_id
        ), unseen AS (
          SELECT s.bank_id,
            max(s.difficulty = p.level) AS has_current, min(CASE WHEN s.difficulty > p.level THEN s.difficulty END) AS higher
          FROM scoped s JOIN pool_levels p ON p.bank_id = s.bank_id
          WHERE s.due_at IS NULL AND NOT s.was_wrong
          GROUP BY s.bank_id
        ), classified AS (
          SELECT s.*, p.level, p.epoch,
            CASE
              WHEN s.was_wrong OR s.due_at <= :now THEN 'review'
              WHEN s.due_at IS NOT NULL THEN CASE WHEN :allowEarly THEN 'early' END
              WHEN s.difficulty <= p.level THEN 'current'
              WHEN :study = 1 THEN 'challenge'
              WHEN s.difficulty = u.higher AND (
                NOT u.has_current OR (
                  s.difficulty = p.level + 1 AND p.level = p.saved_level
                  AND json_array_length(p.samples_json) >= ${CHALLENGE_SAMPLES}
                  AND (SELECT count(*) FROM json_each(p.samples_json)
                       WHERE json_extract(value, '$.correct') = 1) >= ${CHALLENGE_CORRECT}
                )
              ) THEN 'challenge'
            END AS role
          FROM scoped s JOIN pool_levels p ON p.bank_id = s.bank_id
          LEFT JOIN unseen u ON u.bank_id = s.bank_id
        ), distinct_variants AS (
          SELECT *, row_number() OVER (
            PARTITION BY
              CASE WHEN subject_key IS NULL THEN role END,
              CASE WHEN subject_key IS NOT NULL THEN bank_id END,
              subject_key, concept_key,
              CASE WHEN subject_key IS NULL AND concept_key IS NULL THEN id END
            ORDER BY CASE role WHEN 'review' THEN 0 WHEN 'current' THEN 1 WHEN 'challenge' THEN 2 ELSE 3 END,
              due_at, CASE role WHEN 'current' THEN -difficulty ELSE difficulty END, ordinal
          ) AS variant
          FROM classified WHERE role IS NOT NULL
        ), ranked AS (
          SELECT *, row_number() OVER (
            PARTITION BY role ORDER BY
              CASE WHEN role <> 'early' THEN last_seen_at END NULLS FIRST,
              due_at, CASE role WHEN 'current' THEN -difficulty ELSE difficulty END, ordinal
          ) AS priority
          FROM distinct_variants WHERE variant = 1
        )
        SELECT id, bank_id, difficulty, concept_key, level, epoch, role, last_seen_at
        FROM ranked WHERE priority <= :count ORDER BY priority
      `),
    }
  }

  const scopes = {
    all: [queries('all', false), queries('all', true)],
    mistakes: [queries('mistakes', false), queries('mistakes', true)],
    favorites: [queries('favorites', false), queries('favorites', true)],
  } as const

  function scopeFor({ bankId, source, requiresMaterial }: LearningSelection) {
    const index = bankId === null ? 0 : 1
    const parameters = {
      study: Number(requiresMaterial ?? false),
      ...(bankId === null ? {} : { bankId }),
    }
    const selected = scopes[source][index]
    const statements =
      source === 'mistakes' && !selected.exists.get(parameters) ? scopes.all[index] : selected
    return { statements, parameters }
  }

  return {
    pick(count, selection, now, allowEarly) {
      const { statements, parameters } = scopeFor(selection)
      if (!statements.exists.get(parameters)) {
        return {
          questions: [],
          notice: selection.requiresMaterial
            ? 'empty-study'
            : selection.source === 'favorites'
              ? 'empty-favorites'
              : 'empty-bank',
        }
      }
      const candidates = statements.pick
        .all({ ...parameters, count, now, allowEarly: Number(allowEarly) })
        .map(
          (row): LearningCandidate => ({
            id: String(row.id),
            bankId: String(row.bank_id),
            ...(typeof row.concept_key === 'string' ? { conceptKey: row.concept_key } : {}),
            ...(typeof row.last_seen_at === 'number' ? { materialSeenAt: row.last_seen_at } : {}),
            difficulty: row.difficulty as Difficulty,
            level: row.level as Difficulty,
            epoch: Number(row.epoch),
            role: row.role as LearningCandidate['role'],
          }),
        )
      const picked = selection.requiresMaterial
        ? chooseStudyRound(candidates, count)
        : chooseProgressiveRound(candidates, count)
      const questions = picked.map(({ id, bankId, difficulty, level, epoch, role }) => {
        const row = question.get(id)!
        return {
          ...withPartsOfSpeech(questionFromRow(row), bankId),
          bankName: String(row.bank_name),
          ...(isBankLanguage(row.bank_language) ? { language: row.bank_language } : {}),
          learning: {
            bankId,
            difficulty,
            level,
            epoch,
            role,
            calibrates: selection.source === 'all' && role === 'current' && difficulty === level,
          },
        }
      })
      return { questions, notice: questions.length ? null : 'nothing-due' }
    },
    status(selection, now) {
      const { statements, parameters } = scopeFor(selection)
      return {
        level: selection.bankId === null ? null : (read(selection.bankId).profile?.level ?? null),
        dueCount: Number(statements.due.get({ ...parameters, now })?.count),
      }
    },
  }
}

/** These writes are part of the existing answer and round-completion transactions. */
export function createLearningProgressWriter(database: DatabaseSync) {
  const { read } = profiles(database)
  const previous = database.prepare(
    'SELECT step, due_at, last_attempt_at FROM question_learning WHERE question_id = ?',
  )
  const saveAttempt = database.prepare(`
    INSERT INTO question_learning (question_id, step, due_at, last_attempt_at)
    SELECT id, ?, ?, ? FROM questions WHERE id = ?
    ON CONFLICT (question_id) DO UPDATE SET
      step = excluded.step, due_at = excluded.due_at, last_attempt_at = excluded.last_attempt_at
  `)
  const questionExists = database.prepare(
    'SELECT 1 FROM questions WHERE id = ? AND bank_id = ? AND effective_difficulty = ?',
  )
  const saveProfile = database.prepare(`
    INSERT INTO bank_learning_profiles (bank_id, level, epoch, samples_json) VALUES (?, ?, ?, ?)
    ON CONFLICT (bank_id) DO UPDATE SET
      level = excluded.level, epoch = excluded.epoch, samples_json = excluded.samples_json
  `)

  return {
    recordAttempt({ questionId, outcome, at }: ReviewAttempt) {
      if (outcome === 'ungraded') return
      const row = previous.get(questionId)
      const progress = afterGradedAnswer(
        row
          ? {
              step: Number(row.step),
              dueAt: Number(row.due_at),
              lastAttemptAt: Number(row.last_attempt_at),
            }
          : undefined,
        outcome,
        at,
      )
      saveAttempt.run(progress.step, progress.dueAt, progress.lastAttemptAt, questionId)
    },
    recordCompleted(session: LearningSession) {
      if (session.strategy !== 'progressive') return
      const answers = new Map(
        session.answers.map((answer) => [answer.questionId, answer.feedback.outcome]),
      )
      const byBank = new Map<
        string,
        { level: Difficulty; epoch: number; samples: CalibrationSample[] }
      >()
      for (const { id, learning } of session.questions) {
        const outcome = answers.get(id)
        if (!learning?.calibrates || (outcome !== 'correct' && outcome !== 'incorrect')) continue
        const { bankId, level, epoch, difficulty } = learning
        if (!questionExists.get(id, bankId, difficulty)) continue
        const group = byBank.get(bankId) ?? { level, epoch, samples: [] }
        group.samples.push({ id, correct: outcome === 'correct' })
        byBank.set(bankId, group)
      }
      for (const [bankId, { level, epoch, samples }] of byBank) {
        const { profile, available } = read(bankId)
        if (!profile || profile.level !== level || profile.epoch !== epoch) continue
        const result = calibrate(profile, samples, available)
        saveProfile.run(bankId, result.level, result.epoch, JSON.stringify(result.samples))
      }
    },
  }
}
