import type { AppInfo } from '../shared/ipc'

export interface AppRuntime {
  getVersion(): string
  platform: string
}

export function getAppInfo(runtime: AppRuntime): AppInfo {
  return { version: runtime.getVersion(), platform: runtime.platform }
}
