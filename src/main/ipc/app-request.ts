import { RequestError } from '../../application/request-error'
import type { IpcResult } from '../../shared/ipc'

export function handleAppRequest<T>(
  trusted: boolean,
  args: readonly unknown[],
  arity: number,
  action: (...args: unknown[]) => T,
  reportError: (error: unknown) => void,
): IpcResult<T> {
  if (!trusted) {
    return { ok: false, error: { code: 'FORBIDDEN', message: '此页面没有访问权限。' } }
  }

  if (args.length !== arity) {
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: '请求参数数量无效。' } }
  }

  try {
    return { ok: true, data: action(...args) }
  } catch (error) {
    if (error instanceof RequestError) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    reportError(error)
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: '桌面进程处理请求失败。' } }
  }
}
