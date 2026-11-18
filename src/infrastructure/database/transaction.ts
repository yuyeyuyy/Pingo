import type { DatabaseSync } from 'node:sqlite'

export function writeTransaction(database: DatabaseSync, write: () => void): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    write()
    database.exec('COMMIT')
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  }
}
