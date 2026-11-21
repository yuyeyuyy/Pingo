import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/infrastructure/database/open'

let tempDirectory: string

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'pingo-db-'))
})

afterEach(() => {
  rmSync(tempDirectory, { recursive: true, force: true })
})

describe('SQLite initialization', () => {
  it('creates the user-data directory and migrates the file once across restarts', () => {
    const userData = join(tempDirectory, 'userData')
    const db = openDatabase(userData)
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(10)
      expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
      db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)').run('sample', 'saved')
    } finally {
      db.close()
    }
    expect(db.isOpen).toBe(false)

    const reopened = openDatabase(userData)
    try {
      expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(10)
      expect(
        reopened.prepare('SELECT value FROM app_metadata WHERE key = ?').get('sample')?.value,
      ).toBe('saved')
    } finally {
      reopened.close()
    }
  })

  it('upgrades a version 1 database without modifying existing metadata', () => {
    const original = new DatabaseSync(join(tempDirectory, 'pingo.sqlite'))
    original.exec(`
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
      INSERT INTO app_metadata (key, value) VALUES ('legacy', 'preserved');
      PRAGMA user_version = 1
    `)
    original.close()

    const current = openDatabase(tempDirectory)
    try {
      expect(current.prepare('PRAGMA user_version').get()?.user_version).toBe(10)
      expect(
        current.prepare("SELECT value FROM app_metadata WHERE key = 'legacy'").get()?.value,
      ).toBe('preserved')
      expect(current.prepare('SELECT id FROM question_banks').all()).toEqual([])
      expect(current.prepare('SELECT id FROM questions').all()).toEqual([])
    } finally {
      current.close()
    }
  })

  it('assigns English to old language banks and leaves basic banks without a language', () => {
    const db = openDatabase(tempDirectory)
    db.exec(`
      ALTER TABLE question_banks DROP COLUMN language;
      PRAGMA user_version = 9;
      INSERT INTO question_banks VALUES ('vocabulary', '旧词库', 'language');
      INSERT INTO question_banks VALUES ('general', '旧题库', 'basic');
    `)
    db.close()
    const migrated = openDatabase(tempDirectory)
    try {
      expect(migrated.prepare('SELECT id, language FROM question_banks ORDER BY id').all()).toEqual(
        [
          { id: 'general', language: null },
          { id: 'vocabulary', language: 'en' },
        ],
      )
    } finally {
      migrated.close()
    }
  })

  it('preserves a file with a schema version newer than this build', () => {
    const file = join(tempDirectory, 'pingo.sqlite')
    const future = new DatabaseSync(file)
    future.exec('PRAGMA user_version = 99')
    future.close()

    expect(() => openDatabase(tempDirectory)).toThrow('Unsupported Pingo database version: 99')

    const reopened = new DatabaseSync(file, { readOnly: true })
    try {
      expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(99)
    } finally {
      reopened.close()
    }
  })

  it('releases the migration lock and preserves the version when schema setup fails', () => {
    const file = join(tempDirectory, 'pingo.sqlite')
    const original = new DatabaseSync(file)
    original.exec('CREATE TABLE app_metadata (legacy_value TEXT)')
    original.close()

    expect(() => openDatabase(tempDirectory)).toThrow(/already exists/)

    const reopened = new DatabaseSync(file)
    try {
      expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(0)
      reopened.exec('DROP TABLE app_metadata')
    } finally {
      reopened.close()
    }
    openDatabase(tempDirectory).close()
  })
})
