import type { BankLanguage } from '../domain/language'
import { normalizedSpokenWord } from '../domain/pronunciation'
import type { PronunciationClip } from '../domain/pronunciation'
import { RequestError } from './request-error'

export interface PronunciationAdapter {
  lookup(word: string): Promise<PronunciationClip | null>
}

export function createPronunciationService(
  adapters: Partial<Record<BankLanguage, PronunciationAdapter>>,
) {
  const cache = new Map<string, { clip: PronunciationClip | null; until: number }>()
  const pending = new Map<string, Promise<PronunciationClip | null>>()

  return function lookup(language: BankLanguage, text: string): Promise<PronunciationClip | null> {
    const word = normalizedSpokenWord(text)
    const adapter = adapters[language]
    if (!word || !adapter) throw new RequestError('INVALID_ARGUMENTS', '当前没有可用的单词发音。')
    const key = `${language}:${word}`
    const cached = cache.get(key)
    if (cached && cached.until > Date.now()) {
      cache.delete(key)
      cache.set(key, cached)
      return Promise.resolve(cached.clip)
    }
    cache.delete(key)
    const inFlight = pending.get(key)
    if (inFlight) return inFlight
    if (pending.size >= 8) throw new RequestError('INVALID_ARGUMENTS', '发音请求较多，请稍后重试。')

    const request = adapter
      .lookup(word)
      .then((clip) => {
        if (cache.size >= 48) cache.delete(cache.keys().next().value!)
        cache.set(key, { clip, until: Date.now() + (clip ? 60 : 5) * 60_000 })
        return clip
      })
      .catch(() => {
        throw new RequestError('NOT_FOUND', '暂时无法获取发音，请检查网络后重试。')
      })
      .finally(() => {
        pending.delete(key)
      })
    pending.set(key, request)
    return request
  }
}

export type PronunciationService = ReturnType<typeof createPronunciationService>
