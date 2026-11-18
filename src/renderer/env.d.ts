import type { PingoApi } from '../shared/ipc'

declare global {
  interface Window {
    pingo?: PingoApi
  }
}
