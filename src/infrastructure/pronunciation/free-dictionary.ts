import type { PronunciationAdapter } from '../../application/pronunciation'

const API = 'https://api.dictionaryapi.dev'
const AUDIO_PATHS = {
  [API]: '/media/pronunciations/en/',
  'https://ssl.gstatic.com': '/dictionary/static/sounds/',
  'https://upload.wikimedia.org': '/wikipedia/',
} as const
const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'application/ogg',
  'audio/wav',
  'audio/x-wav',
])

function phoneticUrls(data: unknown): URL[] {
  if (!Array.isArray(data)) throw new Error('Unexpected dictionary result')
  const urls = new Map<string, URL>()
  for (const entry of data) {
    if (!Array.isArray(entry?.phonetics)) continue
    for (const phonetic of entry.phonetics) {
      const source: unknown = phonetic?.audio
      if (typeof source !== 'string' || !source.trim()) continue
      const url = URL.parse(source, API)
      if (!url || url.username || url.password || !Object.hasOwn(AUDIO_PATHS, url.origin)) continue
      const prefix = AUDIO_PATHS[url.origin as keyof typeof AUDIO_PATHS]
      if (url.pathname.startsWith(prefix)) urls.set(url.href, url)
      if (urls.size === 3) return [...urls.values()]
    }
  }
  return [...urls.values()]
}

async function boundedBody(response: Response, maximum: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing dictionary response')
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new Error('Dictionary response is too large')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes.buffer
  } finally {
    reader.releaseLock()
  }
}

export function createFreeDictionaryAdapter(fetcher: typeof fetch = fetch): PronunciationAdapter {
  return {
    async lookup(word) {
      const signal = AbortSignal.timeout(8_000)
      const options = { signal, redirect: 'error', credentials: 'omit' } as const
      const dictionary = await fetcher(
        `${API}/api/v2/entries/en/${encodeURIComponent(word)}`,
        options,
      )
      if (!dictionary.ok) {
        await dictionary.body?.cancel()
        if (dictionary.status === 404) return null
        throw new Error('Dictionary request failed')
      }
      const data: unknown = JSON.parse(
        new TextDecoder().decode(await boundedBody(dictionary, 512 * 1024)),
      )
      for (const url of phoneticUrls(data)) {
        const audio = await fetcher(url, options)
        const mimeType = audio.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (!audio.ok || !mimeType || !AUDIO_TYPES.has(mimeType)) {
          await audio.body?.cancel()
          if (audio.status >= 500 || audio.status === 429)
            throw new Error('Dictionary audio request failed')
          continue
        }
        const bytes = await boundedBody(audio, 512 * 1024)
        if (bytes.byteLength) return { mimeType, bytes }
      }
      return null
    },
  }
}
