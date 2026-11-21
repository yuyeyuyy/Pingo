import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_BANK_LANGUAGE } from '../../domain/language'
import { writeTransaction } from './transaction'

const migrations = [
  `CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE question_banks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120)
  ) STRICT;

  CREATE TABLE questions (
    id TEXT PRIMARY KEY NOT NULL,
    bank_id TEXT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
    options_json TEXT,
    correct_option_index INTEGER,
    reference_answer TEXT,
    CHECK (
      (kind = 'multiple-choice'
        AND options_json IS NOT NULL
        AND json_valid(options_json) = 1
        AND json_type(options_json) = 'array'
        AND json_array_length(options_json) BETWEEN 2 AND 20
        AND correct_option_index IS NOT NULL
        AND correct_option_index >= 0
        AND correct_option_index < json_array_length(options_json)
        AND reference_answer IS NULL)
      OR
      (kind = 'short-answer' AND options_json IS NULL AND correct_option_index IS NULL)
    )
  ) STRICT;

  CREATE INDEX questions_bank_id ON questions (bank_id)`,
  `CREATE TABLE reminder_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    payload TEXT NOT NULL CHECK (json_valid(payload))
  ) STRICT;

  CREATE TABLE learning_history (
    session_id TEXT PRIMARY KEY NOT NULL,
    ended_at INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'skipped')),
    payload TEXT NOT NULL CHECK (json_valid(payload))
  ) STRICT`,
  // Keep IDs and insertion order so saved sessions and existing navigation remain valid.
  `ALTER TABLE question_banks ADD COLUMN template TEXT NOT NULL DEFAULT 'basic'
    CHECK (template IN ('basic', 'language'));

  CREATE TABLE questions_v4 (
    id TEXT PRIMARY KEY NOT NULL,
    bank_id TEXT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('multiple-choice', 'short-answer', 'fill-in', 'ordering')),
    prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
    content_json TEXT NOT NULL CHECK (json_valid(content_json) AND json_type(content_json) = 'object')
  ) STRICT;

  INSERT INTO questions_v4 (rowid, id, bank_id, kind, prompt, content_json)
    SELECT rowid, id, bank_id, kind, prompt,
      CASE
        WHEN kind = 'multiple-choice' THEN
          json_object('options', json(options_json), 'correctOptionIndex', correct_option_index)
        WHEN reference_answer IS NOT NULL THEN json_object('referenceAnswer', reference_answer)
        ELSE '{}'
      END
    FROM questions;

  DROP TABLE questions;
  ALTER TABLE questions_v4 RENAME TO questions;
  CREATE INDEX questions_bank_id ON questions (bank_id)`,
  `CREATE TABLE wrong_questions (
    question_id TEXT PRIMARY KEY NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    consecutive_correct INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_correct IN (0, 1))
  ) STRICT;

  CREATE TABLE favorite_questions (
    question_id TEXT PRIMARY KEY NOT NULL REFERENCES questions(id) ON DELETE CASCADE
  ) STRICT`,
  `ALTER TABLE questions ADD COLUMN difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 5);
  ALTER TABLE questions ADD COLUMN concept_key TEXT CHECK (length(concept_key) BETWEEN 1 AND 160);
  ALTER TABLE questions ADD COLUMN effective_difficulty INTEGER GENERATED ALWAYS AS (
    coalesce(difficulty, CASE
      WHEN json_extract(content_json, '$.languageType') = 'word-to-meaning' THEN 1
      WHEN kind = 'multiple-choice' THEN 2
      WHEN kind = 'ordering' THEN 4
      ELSE 3 END)
  ) VIRTUAL;
  CREATE INDEX questions_bank_difficulty ON questions (bank_id, effective_difficulty);

  CREATE TABLE question_learning (
    question_id TEXT PRIMARY KEY NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 5),
    due_at INTEGER NOT NULL,
    last_attempt_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX question_learning_due ON question_learning (due_at);

  CREATE TABLE bank_learning_profiles (
    bank_id TEXT PRIMARY KEY NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    samples_json TEXT NOT NULL CHECK (json_valid(samples_json) AND json_type(samples_json) = 'array' AND json_array_length(samples_json) <= 10)
  ) STRICT`,
  `CREATE TABLE study_materials (
    id INTEGER PRIMARY KEY,
    bank_id TEXT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 160),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    explanation TEXT NOT NULL CHECK (length(explanation) BETWEEN 1 AND 10000),
    examples_json TEXT NOT NULL CHECK (json_valid(examples_json) AND json_type(examples_json) = 'array' AND json_array_length(examples_json) <= 5),
    UNIQUE (bank_id, key)
  ) STRICT;
  ALTER TABLE questions ADD COLUMN material_id INTEGER REFERENCES study_materials(id) ON DELETE SET NULL;
  CREATE INDEX questions_study_material ON questions (material_id) WHERE material_id IS NOT NULL`,
  `CREATE INDEX questions_bank_vocabulary_concept ON questions (bank_id, concept_key)
    WHERE kind = 'multiple-choice' AND concept_key IS NOT NULL`,
  `CREATE TABLE study_material_progress (
    bank_id TEXT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    subject_key TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (bank_id, subject_key)
  ) STRICT;

  WITH previous_sessions AS (
    SELECT payload, ended_at AS seen_at, json_array_length(payload, '$.study.materials') - 1 AS last_index
    FROM learning_history
    WHERE json_type(payload, '$.study.materials') = 'array'
    UNION ALL
    SELECT json_extract(payload, '$.session'),
      json_extract(payload, '$.session.startedAt'),
      json_extract(payload, '$.session.study.index')
    FROM reminder_state
    WHERE json_type(payload, '$.session.study.materials') = 'array'
      AND (json_extract(payload, '$.session.stage') <> 'pending'
        OR json_extract(payload, '$.session.study.index') > 0)
  )
  INSERT INTO study_material_progress (bank_id, subject_key, last_seen_at)
  SELECT m.bank_id, pingo_study_subject(b.template, m.title, m.key), max(s.seen_at)
  FROM previous_sessions s
  JOIN json_each(s.payload, '$.questions') saved
  JOIN questions q ON q.id = json_extract(saved.value, '$.id')
  JOIN study_materials m ON m.id = q.material_id
  JOIN question_banks b ON b.id = m.bank_id
  WHERE s.seen_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(s.payload, '$.study.materials') card
    WHERE card.key <= s.last_index AND json_extract(card.value, '$.key') = m.key
  )
  GROUP BY m.bank_id, pingo_study_subject(b.template, m.title, m.key)`,
  `ALTER TABLE question_banks ADD COLUMN language TEXT;
  UPDATE question_banks SET language = '${DEFAULT_BANK_LANGUAGE}' WHERE template = 'language'`,
  `CREATE TABLE correctly_answered_questions (
    question_id TEXT PRIMARY KEY NOT NULL REFERENCES questions(id) ON DELETE CASCADE
  ) STRICT;

  WITH previous_answers(question_id) AS (
    SELECT question_id FROM question_learning WHERE step > 0
    UNION
    SELECT json_extract(answer.value, '$.questionId')
    FROM learning_history h JOIN json_each(h.payload, '$.answers') answer
    WHERE json_extract(answer.value, '$.feedback.outcome') = 'correct'
    UNION
    SELECT json_extract(answer.value, '$.questionId')
    FROM reminder_state s JOIN json_each(s.payload, '$.session.answers') answer
    WHERE json_extract(answer.value, '$.feedback.outcome') = 'correct'
  )
  INSERT INTO correctly_answered_questions (question_id)
  SELECT q.id FROM previous_answers a JOIN questions q ON q.id = a.question_id`,
  `ALTER TABLE question_learning ADD COLUMN last_correct_round INTEGER CHECK (last_correct_round >= 0)`,
  `CREATE TABLE question_learning_v13 (
    question_id TEXT PRIMARY KEY NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 7),
    due_at INTEGER NOT NULL,
    last_attempt_at INTEGER NOT NULL
  ) STRICT;

  INSERT INTO question_learning_v13 (question_id, step, due_at, last_attempt_at)
  SELECT l.question_id, CASE WHEN l.step = 0 AND c.question_id IS NOT NULL THEN 1 ELSE l.step END,
    CASE
      WHEN l.step BETWEEN 1 AND 2 OR l.last_correct_round IS NOT NULL AND l.step = 0 THEN l.last_attempt_at
      WHEN l.step = 3 THEN min(l.due_at, l.last_attempt_at + 86400000)
      WHEN l.step = 4 THEN min(l.due_at, l.last_attempt_at + 259200000)
      WHEN l.step = 5 THEN min(l.due_at, l.last_attempt_at + 604800000)
      ELSE l.due_at
    END, l.last_attempt_at
  FROM question_learning l LEFT JOIN correctly_answered_questions c ON c.question_id = l.question_id;

  INSERT OR IGNORE INTO question_learning_v13 (question_id, step, due_at, last_attempt_at)
  SELECT question_id, 1, 0, 0 FROM correctly_answered_questions;

  DROP TABLE question_learning;
  ALTER TABLE question_learning_v13 RENAME TO question_learning;
  CREATE INDEX question_learning_due ON question_learning (due_at);
  UPDATE reminder_state SET payload = json_remove(payload, '$.settings.reviewAfterRounds')
  WHERE json_type(payload, '$.settings.reviewAfterRounds') IS NOT NULL`,
  `UPDATE question_learning AS l SET
    step = CASE
      WHEN l.step = 0 OR l.due_at > l.last_attempt_at OR EXISTS (
        SELECT 1 FROM wrong_questions w WHERE w.question_id = l.question_id AND w.consecutive_correct = 0
      ) THEN 2
      ELSE 1
    END,
    due_at = l.last_attempt_at
  WHERE l.step < 3;

  INSERT OR IGNORE INTO question_learning (question_id, step, due_at, last_attempt_at)
  SELECT question_id, CASE WHEN consecutive_correct = 0 THEN 2 ELSE 1 END, 0, 0 FROM wrong_questions;

  UPDATE reminder_state SET payload = json_set(payload, '$.session.questions', json((
    SELECT json_group_array(json(CASE
      WHEN json_extract(question.value, '$.learning.pool') = 'review-twice'
      THEN json_set(question.value, '$.learning.pool', 'review-once')
      ELSE question.value END) ORDER BY question.key)
    FROM json_each(payload, '$.session.questions') question
  ))) WHERE EXISTS (
    SELECT 1 FROM json_each(payload, '$.session.questions') question
    WHERE json_extract(question.value, '$.learning.pool') = 'review-twice'
  )`,
  `CREATE TABLE bank_learning_strategies (
    bank_id TEXT PRIMARY KEY NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
    strategy TEXT NOT NULL CHECK (strategy IN ('random', 'progressive'))
  ) STRICT;

  INSERT INTO bank_learning_strategies (bank_id, strategy)
  SELECT b.id, CASE WHEN json_extract(s.payload, '$.settings.strategy') = 'progressive'
    THEN 'progressive' ELSE 'random' END
  FROM question_banks b CROSS JOIN reminder_state s`,
]

function migrate(database: DatabaseSync): void {
  writeTransaction(database, () => {
    const version = database.prepare('PRAGMA user_version').get()?.user_version
    if (typeof version !== 'number' || version < 0 || version > migrations.length) {
      throw new Error(`Unsupported Pingo database version: ${version}`)
    }

    for (const [index, migration] of migrations.entries()) {
      const nextVersion = index + 1
      if (nextVersion <= version) continue
      database.exec(migration)
      database.exec(`PRAGMA user_version = ${nextVersion}`)
    }
  })
}

/** Opens and migrates the main-process connection. The caller owns its lifetime. */
export function openDatabase(userDataDirectory: string): DatabaseSync {
  mkdirSync(userDataDirectory, { recursive: true })
  const database = new DatabaseSync(join(userDataDirectory, 'pingo.sqlite'), {
    enableForeignKeyConstraints: true,
    timeout: 2_000,
  })
  try {
    database.function('pingo_study_subject', { deterministic: true }, (template, title, key) =>
      template === 'language'
        ? String(title).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
        : String(key),
    )
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
