import { pathToFileURL } from 'node:url'

export type RendererEntry =
  | { kind: 'development'; url: string }
  | { kind: 'file'; path: string; url: string }

export function resolveRendererEntry(
  isPackaged: boolean,
  devServerUrl: string | undefined,
  rendererFile: string,
): RendererEntry {
  if (!isPackaged && devServerUrl) {
    const url = new URL(devServerUrl)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('Pingo requires a loopback Vite development URL.')
    }
    return { kind: 'development', url: url.href }
  }

  return { kind: 'file', path: rendererFile, url: pathToFileURL(rendererFile).href }
}
