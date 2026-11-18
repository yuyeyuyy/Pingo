import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
