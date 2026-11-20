import type { DatabaseSync } from 'node:sqlite'
import { normalizePartOfSpeech } from '../../domain/part-of-speech'
import type { PartOfSpeech } from '../../domain/part-of-speech'
import type { Question } from '../../domain/question'

function normalized(value: string) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function keyPart(key: string | undefined, word: string) {
  const [lexeme, part] = key?.split(':', 3) ?? []
  return lexeme === word && part ? normalizePartOfSpeech(part) : undefined
}

export function createOptionPartsOfSpeechLookup(database: DatabaseSync) {
  const candidates = database.prepare(`
    WITH vocabulary AS (
      SELECT concept_key, json_extract(content_json, '$.languageType') AS type,
        json_extract(content_json, '$.options[' || json_extract(content_json, '$.correctOptionIndex') || ']') AS label,
        json_extract(content_json, '$.optionExplanations[' || json_extract(content_json, '$.correctOptionIndex') || ']') AS explanation
      FROM questions
      WHERE bank_id = ? AND kind = 'multiple-choice' AND concept_key >= ? AND concept_key < ?
    )
    SELECT concept_key,
      CASE type WHEN 'word-to-meaning' THEN explanation ELSE label END AS word,
      CASE type WHEN 'word-to-meaning' THEN label ELSE explanation END AS gloss
    FROM vocabulary WHERE type IN ('word-to-meaning', 'meaning-to-word')
  `)

  return (question: Question, bankId: string): Question => {
    if (question.kind !== 'multiple-choice' || !question.optionExplanations) return question
    const type = question.languageType
    if (type !== 'word-to-meaning' && type !== 'meaning-to-word') return question

    const parts = question.options.map((option, index) => {
      const explicit = question.optionPartsOfSpeech?.[index]
      if (explicit) return explicit
      const explanation = question.optionExplanations?.[index]
      if (!explanation) return null
      const word = normalized(type === 'word-to-meaning' ? explanation : option)
      const gloss = normalized(type === 'word-to-meaning' ? option : explanation)
      if (index === question.correctOptionIndex) {
        const part = keyPart(question.conceptKey, word)
        if (part) return part
      }

      // Legacy vocabulary banks can attest the same word and gloss in another question.
      const matching = new Set<PartOfSpeech>()
      for (const row of candidates.all(bankId, `${word}:`, `${word};`)) {
        if (
          typeof row.word !== 'string' ||
          normalized(row.word) !== word ||
          typeof row.gloss !== 'string' ||
          normalized(row.gloss) !== gloss
        )
          continue
        const part = keyPart(String(row.concept_key), word)
        if (part) matching.add(part)
      }
      return matching.size === 1 ? (matching.values().next().value ?? null) : null
    })
    return parts.some(Boolean) ? { ...question, optionPartsOfSpeech: parts } : question
  }
}
