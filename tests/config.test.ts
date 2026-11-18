import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveRendererEntry } from '../src/main/bootstrap/config'

const rendererFile = resolve('some build', 'renderer', 'index.html')
const devUrl = 'http://127.0.0.1:5173/'

describe('renderer entry configuration', () => {
  it('uses the Vite server in development', () => {
    expect(resolveRendererEntry(false, devUrl, rendererFile)).toEqual({
      kind: 'development',
      url: devUrl,
    })
  })

  it.each([
    [true, devUrl],
    [false, undefined],
  ] as const)('uses the built file for packaged=%s and Vite URL=%s', (packaged, url) => {
    expect(resolveRendererEntry(packaged, url, rendererFile)).toEqual({
      kind: 'file',
      path: rendererFile,
      url: pathToFileURL(rendererFile).href,
    })
  })

  it.each(['https://example.test', 'http://127.0.0.1.example.test', 'http://user@127.0.0.1'])(
    'rejects unsupported development URL %s',
    (url) => {
      expect(() => resolveRendererEntry(false, url, rendererFile)).toThrow('loopback Vite')
    },
  )
})
