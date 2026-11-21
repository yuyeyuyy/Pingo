import { expect, it, vi } from 'vitest'
import { createPronunciationService } from '../src/application/pronunciation'
import { createFreeDictionaryAdapter } from '../src/infrastructure/pronunciation/free-dictionary'

it('reads permitted Free Dictionary phonetics URLs and returns bounded audio bytes', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([
        {
          phonetics: [
            { audio: '' },
            { audio: 'https://invalid.example/file.mp3' },
            { audio: 'https://api.dictionaryapi.dev/api/invalid' },
            { audio: '//ssl.gstatic.com/dictionary/static/sounds/example.mp3' },
          ],
        },
      ]),
    )
    .mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    )
  const clip = await createFreeDictionaryAdapter(fetcher).lookup('ice cream')
  expect(clip?.mimeType).toBe('audio/mpeg')
  expect([...new Uint8Array(clip!.bytes)]).toEqual([1, 2, 3])
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    'https://api.dictionaryapi.dev/api/v2/entries/en/ice%20cream',
  )
  expect(String(fetcher.mock.calls[1]?.[0])).toBe(
    'https://ssl.gstatic.com/dictionary/static/sounds/example.mp3',
  )
  expect(fetcher.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true)
})

it('handles missing recordings and refuses oversized audio', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 }))
  const adapter = createFreeDictionaryAdapter(fetcher)
  await expect(adapter.lookup('unknown')).resolves.toBeNull()
  fetcher
    .mockResolvedValueOnce(
      Response.json([{ phonetics: [{ audio: '/media/pronunciations/en/hello-uk.mp3' }] }]),
    )
    .mockResolvedValueOnce(
      new Response(new Uint8Array(512 * 1024 + 1), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    )
  await expect(adapter.lookup('hello')).rejects.toThrow('too large')
})

it('deduplicates concurrent word requests, caches clips and retries a network failure', async () => {
  const clip = { mimeType: 'audio/mpeg', bytes: new Uint8Array([1]).buffer }
  const provider = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(clip)
  const lookup = createPronunciationService({ en: { lookup: provider } })
  await expect(lookup('en', 'hello')).rejects.toThrow('检查网络')
  const retry = lookup('en', ' Hello ')
  expect(lookup('en', 'hello')).toBe(retry)
  await expect(retry).resolves.toEqual(clip)
  await expect(lookup('en', 'HELLO')).resolves.toEqual(clip)
  expect(provider).toHaveBeenCalledTimes(2)
  expect(() => lookup('ja', 'hello')).toThrow('没有可用')
})
