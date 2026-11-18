import { app, dialog, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createQuestionBankService } from '../application/question-bank/service'
import { SchedulerService } from '../application/reminders/scheduler'
import { openDatabase } from '../infrastructure/database/open'
import { createQuestionBankRepository } from '../infrastructure/database/question-bank-repository'
import {
  createLearningQuestionSource,
  createReminderStore,
} from '../infrastructure/database/reminder-store'
import { resolveRendererEntry } from './bootstrap/config'
import { installApplicationMenu } from './bootstrap/menu'
import { registerIpc } from './ipc/register'
import { createReminderNotifications, monitorReminderSystem } from './reminders/desktop'
import { createTray } from './tray/create-tray'
import { createWindowManager } from './windows/window-manager'

function start(): void {
  // Keeping a window hidden allows both the Dock and tray to restore it.
  let windows: ReturnType<typeof createWindowManager> | undefined
  let tray: ReturnType<typeof createTray> | undefined
  let database: ReturnType<typeof openDatabase> | undefined
  let unregisterIpc: (() => void) | undefined
  let reminders: SchedulerService | undefined
  let system: ReturnType<typeof monitorReminderSystem> | undefined

  app.on('activate', () => windows?.openMain())
  app.on('second-instance', () => windows?.openMain())
  app.on('window-all-closed', () => {
    // The tray continues serving the app even if all its windows are destroyed.
  })
  app.on('before-quit', () => {
    windows?.beginQuit()
    reminders?.stop()
    system?.dispose()
  })
  app.once('will-quit', () => {
    unregisterIpc?.()
    tray?.destroy()
    try {
      database?.close()
    } catch (error) {
      console.error('Failed to close the Pingo database', error)
    }
  })

  void app
    .whenReady()
    .then(() => {
      const entry = resolveRendererEntry(
        app.isPackaged,
        process.env.ELECTRON_RENDERER_URL,
        join(__dirname, '../renderer/index.html'),
      )
      database = openDatabase(app.getPath('userData'))

      session.defaultSession.setPermissionCheckHandler(() => false)
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, allow) =>
        allow(false),
      )

      const desktop = createWindowManager(entry, {
        answerClosed: () => reminders?.windowClosed(),
        answerUnavailable: () => reminders?.windowUnavailable(),
      })
      windows = desktop
      const notifications = createReminderNotifications()
      const power = monitorReminderSystem(
        () => reminders?.suspend(),
        () => {
          try {
            reminders?.wake()
          } catch (error) {
            console.error('Failed to reconcile Pingo reminders after wake', error)
          }
        },
        desktop.isOwnWindowFullscreen,
      )
      system = power
      const scheduler = new SchedulerService({
        store: createReminderStore(database),
        questions: createLearningQuestionSource(database),
        makeId: randomUUID,
        now: Date.now,
        schedule(delay, action) {
          const timer = setTimeout(action, delay)
          return () => clearTimeout(timer)
        },
        system: power.read,
        notify: notifications.notify,
        dismissNotification: notifications.dismiss,
        showAnswer: desktop.openAnswer,
        closeAnswer: desktop.closeAnswer,
        publish(status, answer) {
          desktop.publish(status, answer)
          tray?.setToolTip(status.pendingSessionId ? 'Pingo · 有一轮学习待开始' : 'Pingo')
        },
        reportError: (error) => console.error('Pingo reminder failed', error),
      })
      reminders = scheduler
      unregisterIpc = registerIpc(
        { getVersion: () => app.getVersion(), platform: process.platform },
        desktop.isTrusted,
        createQuestionBankService(createQuestionBankRepository(database), randomUUID),
        scheduler,
      )
      const actions = {
        openMain: desktop.openMain,
        openAnswer: () => {
          try {
            if (scheduler.startLearning().notice === 'empty-bank') desktop.openMain()
          } catch (error) {
            console.error('Failed to start Pingo learning', error)
          }
        },
        quit: () => app.quit(),
      }
      tray = createTray(actions)
      installApplicationMenu(actions)
      scheduler.start()
      desktop.openMain()
    })
    .catch((error: unknown) => {
      console.error('Failed to start Pingo', error)
      dialog.showErrorBox('无法启动 Pingo', '初始化桌面应用或本地数据库时发生错误。')
      app.quit()
    })
}

app.setName('Pingo')
if (app.requestSingleInstanceLock()) start()
else app.quit()
