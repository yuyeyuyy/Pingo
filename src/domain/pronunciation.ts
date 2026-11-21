import { BANK_LANGUAGES } from './language'
import type { BankLanguage } from './language'

export interface WordRange {
  start: number
  end: number
}

export interface PronunciationClip {
  bytes: ArrayBuffer
  mimeType: string
}

export interface PronunciationPreferences {
  voiceURI: string | null
  rate: number
  source: 'dictionary' | 'system'
}

export const PRONUNCIATION_RATE = { min: 0.75, max: 1.25 } as const

export const DEFAULT_PRONUNCIATION_PREFERENCES: Readonly<PronunciationPreferences> = {
  voiceURI: null,
  rate: 1,
  source: 'dictionary',
}

export function supportsPronunciation(language: BankLanguage) {
  return BANK_LANGUAGES[language].pronunciation
}

export function normalizedSpokenWord(text: string | undefined): string | undefined {
  const word = text?.normalize('NFKC').trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ')
  if (word && word.length <= 80 && /^\p{L}[\p{L}\p{M}]*(?:[' -]\p{L}[\p{L}\p{M}]*)*$/u.test(word))
    return word
}

export function locateSpokenWord(
  prompt: string,
  candidates: readonly (string | undefined)[],
): WordRange | undefined {
  for (const candidate of candidates) {
    if (!candidate || !normalizedSpokenWord(candidate)) continue
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`(^|[^\\p{L}\\p{M}])(${escaped})(?=$|[^\\p{L}\\p{M}])`, 'iu').exec(
      prompt,
    )
    if (match) {
      const start = match.index + match[1]!.length
      return { start, end: start + match[2]!.length }
    }
  }
  // Old English banks sometimes only have the visible word in the prompt.
  const words = [...prompt.matchAll(/[a-z]+(?:['’-][a-z]+)*/gi)]
  const first = words[0]
  if (words.length === 1 && first && normalizedSpokenWord(first[0]))
    return { start: first.index, end: first.index + first[0].length }
}
