import { BrowserWindow, dialog } from 'electron'
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { REMINDER_EVENTS } from '../../shared/reminders'
import type { AnswerView, ReminderStatus } from '../../shared/reminders'
import type { RendererEntry } from '../bootstrap/config'

function reveal(window: BrowserWindow, focus: boolean): void {
  if (focus) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  } else {
    window.showInactive()
  }
}

export function createWindowManager(
  entry: RendererEntry,
  lifecycle: { answerClosed(): void; answerUnavailable(): void },
) {
  let mainWindow: BrowserWindow | undefined
  let answerWindow: BrowserWindow | undefined
  let answerReady = false
  let focusAnswer = false
  let quitting = false
  const url = new URL(entry.url)
  url.hash = 'answer'
  const answerUrl = url.href

  function createWindow(
    options: BrowserWindowConstructorOptions,
    route: 'main' | 'answer',
    ready: (window: BrowserWindow) => void,
  ) {
    const window = new BrowserWindow({
      ...options,
      show: false,
      backgroundColor: '#f8f8f7',
      autoHideMenuBar: process.platform !== 'darwin',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.once('ready-to-show', () => ready(window))

    const isAnswer = route === 'answer'
    const loaded =
      entry.kind === 'development'
        ? window.loadURL(isAnswer ? answerUrl : entry.url)
        : window.loadFile(entry.path, isAnswer ? { hash: 'answer' } : undefined)

    void loaded.catch((error: unknown) => {
      if (quitting || window.isDestroyed()) return
      console.error('Failed to load Pingo window', error)
      window.destroy()
      if (isAnswer) lifecycle.answerUnavailable()
      else dialog.showErrorBox('无法打开 Pingo 窗口', '请从菜单重新打开窗口。')
    })

    return window
  }

  return {
    openMain() {
      if (quitting) return
      if (mainWindow) {
        if (mainWindow.isVisible() || !mainWindow.webContents.isLoadingMainFrame())
          reveal(mainWindow, true)
        return
      }

      mainWindow = createWindow(
        {
          title: 'Pingo',
          width: 1120,
          height: 740,
          minWidth: 760,
          minHeight: 560,
          ...(process.platform === 'darwin'
            ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 19, y: 18 } }
            : {}),
        },
        'main',
        (window) => reveal(window, true),
      )

      mainWindow.on('close', (event) => {
        if (quitting) return
        event.preventDefault()
        mainWindow?.hide()
      })
      mainWindow.once('closed', () => {
        mainWindow = undefined
      })
    },

    openAnswer(focus: boolean) {
      if (quitting) return
      if (answerWindow) {
        focusAnswer ||= focus
        if (answerReady && (focus || !answerWindow.isVisible())) reveal(answerWindow, focus)
        return
      }

      answerReady = false
      focusAnswer = focus
      const window = createWindow(
        {
          title: 'Pingo · 学习',
          width: 530,
          height: 535,
          center: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          alwaysOnTop: false,
        },
        'answer',
        (readyWindow) => {
          answerReady = true
          reveal(readyWindow, focusAnswer)
        },
      )
      answerWindow = window
      window.on('close', (event) => {
        if (quitting) return
        try {
          lifecycle.answerClosed()
        } catch (error) {
          event.preventDefault()
          console.error('Failed to save Pingo learning progress', error)
        }
      })
      window.webContents.on('render-process-gone', () => {
        if (quitting || window.isDestroyed()) return
        window.destroy()
        lifecycle.answerUnavailable()
      })
      window.once('closed', () => {
        answerWindow = undefined
        answerReady = false
      })
    },

    closeAnswer() {
      answerWindow?.destroy()
    },

    isOwnWindowFullscreen() {
      return mainWindow?.isFullScreen() ?? false
    },

    publish(status: ReminderStatus, answer: AnswerView) {
      if (mainWindow?.webContents.getURL() === entry.url) {
        mainWindow.webContents.send(REMINDER_EVENTS.status, status)
      }
      if (answerWindow?.webContents.getURL() === answerUrl) {
        answerWindow.webContents.send(REMINDER_EVENTS.answer, answer)
      }
    },

    beginQuit() {
      quitting = true
    },

    isTrusted(event: IpcMainInvokeEvent, route: 'main' | 'answer'): boolean {
      const window = route === 'main' ? mainWindow : answerWindow
      return (
        event.sender === window?.webContents &&
        event.senderFrame === event.sender.mainFrame &&
        event.senderFrame?.url === (route === 'main' ? entry.url : answerUrl)
      )
    },
  }
}
