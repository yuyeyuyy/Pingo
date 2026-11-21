import { Notification, powerMonitor } from 'electron'

export function createReminderNotifications() {
  let notification: Notification | undefined
  return {
    notify(open: () => void) {
      try {
        if (!Notification.isSupported()) return
        notification = new Notification({
          title: 'Pingo · 学习提醒',
          body: '有一轮学习待开始。',
          silent: true,
        })
        notification.once('click', () => {
          try {
            open()
          } catch (error) {
            console.error('Failed to open Pingo learning from notification', error)
          }
        })
        notification.once('failed', (_event, error) => {
          console.warn('Pingo notification unavailable:', error)
        })
        notification.show()
      } catch (error) {
        console.warn('Pingo notification unavailable:', error)
      }
    },
    dismiss() {
      const current = notification
      notification = undefined
      current?.close()
    },
  }
}

export function monitorReminderSystem(
  onSuspend: () => void,
  onResume: () => void,
  isOwnWindowFullscreen: () => boolean,
) {
  let locked = false
  const lock = () => {
    locked = true
  }
  const unlock = () => {
    locked = false
    onResume()
  }

  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)

  return {
    read() {
      const idleState = powerMonitor.getSystemIdleState(300)
      return {
        idle: idleState === 'unknown' ? ('unknown' as const) : idleState === 'idle',
        locked: locked || idleState === 'locked',
        fullscreen: isOwnWindowFullscreen() ? (true as const) : ('unknown' as const),
      }
    },
    dispose() {
      powerMonitor.off('suspend', onSuspend)
      powerMonitor.off('resume', onResume)
      powerMonitor.off('lock-screen', lock)
      powerMonitor.off('unlock-screen', unlock)
    },
  }
}
