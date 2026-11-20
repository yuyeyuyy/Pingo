import type { DatabaseSync } from 'node:sqlite'
import type { SessionStudyMaterial } from '../../domain/session'
import type { StudyExample } from '../../domain/study-material'

export function createStudyMaterialSource(database: DatabaseSync) {
  const select = database.prepare(`
    SELECT m.key, m.title, m.explanation, m.examples_json, b.name AS bank_name,
      b.id AS bank_id, pingo_study_subject(b.template, m.title, m.key) AS subject_key
    FROM json_each(?) AS selected
    JOIN questions q ON q.id = selected.value
    JOIN study_materials m ON m.id = q.material_id AND m.bank_id = q.bank_id
    JOIN question_banks b ON b.id = m.bank_id
    GROUP BY m.id
    ORDER BY min(selected.key)
  `)
  return (questionIds: readonly string[]): SessionStudyMaterial[] =>
    select.all(JSON.stringify(questionIds)).map((row) => ({
      key: String(row.key),
      title: String(row.title),
      explanation: String(row.explanation),
      examples: JSON.parse(String(row.examples_json)) as StudyExample[],
      bankName: String(row.bank_name),
      subject: { bankId: String(row.bank_id), key: String(row.subject_key) },
    }))
}
