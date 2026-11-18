import type { DatabaseSync } from 'node:sqlite'
import type { ReminderState, ReminderStore } from '../../application/reminders/scheduler'
import { questionFromRow } from './question-bank-repository'
import { writeTransaction } from './transaction'

export function createReminderStore(database: DatabaseSync): ReminderStore {
  const load = database.prepare('SELECT payload FROM reminder_state WHERE singleton = 1')
  const save = database.prepare(`
    INSERT INTO reminder_state VALUES (1, ?)
    ON CONFLICT (singleton) DO UPDATE SET payload = excluded.payload
  `)
  const history = database.prepare(`
    INSERT INTO learning_history (session_id, ended_at, outcome, payload) VALUES (?, ?, ?, ?)
  `)
  return {
    load() {
      const row = load.get()
      return row ? (JSON.parse(String(row.payload)) as ReminderState) : undefined
    },
    save(state, ended) {
      const payload = JSON.stringify(state)
      if (!ended) {
        save.run(payload)
        return
      }
      writeTransaction(database, () => {
        history.run(ended.session.id, ended.at, ended.outcome, JSON.stringify(ended.session))
        save.run(payload)
      })
    },
  }
}

export function createLearningQuestionSource(database: DatabaseSync) {
  const sample = database.prepare(`
    SELECT q.id, q.kind, q.prompt, q.options_json, q.correct_option_index, q.reference_answer,
      b.name AS bank_name
    FROM questions q JOIN question_banks b ON b.id = q.bank_id
    ORDER BY random() LIMIT ?
  `)
  return (count: number) =>
    sample.all(count).map((row) => ({ ...questionFromRow(row), bankName: String(row.bank_name) }))
}
