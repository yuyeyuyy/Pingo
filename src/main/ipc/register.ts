import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { getAppInfo } from '../../application/app-info'
import type { AppRuntime } from '../../application/app-info'
import type { QuestionBankService } from '../../application/question-bank/service'
import type { SchedulerService } from '../../application/reminders/scheduler'
import {
  pauseOption,
  reminderSettings,
  sessionId,
  sessionTarget,
  snoozeRequest,
  submitRequest,
} from '../../application/reminders/validation'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { ApiResponse, InvokeApi } from '../../shared/ipc'
import { handleAppRequest } from './app-request'

export function registerIpc(
  runtime: AppRuntime,
  isTrusted: (event: IpcMainInvokeEvent, window: 'main' | 'answer') => boolean,
  banks: QuestionBankService,
  reminders: SchedulerService,
) {
  const handlers: {
    [K in keyof InvokeApi]: {
      arity: Parameters<InvokeApi[K]>['length']
      window?: 'answer'
      run: (...args: unknown[]) => ApiResponse<K>
    }
  } = {
    getAppInfo: { arity: 0, run: () => getAppInfo(runtime) },
    ping: { arity: 0, run: () => 'pong' },
    listBanks: { arity: 0, run: banks.listBanks },
    createBank: { arity: 1, run: banks.createBank },
    renameBank: { arity: 1, run: banks.renameBank },
    deleteBank: { arity: 1, run: banks.deleteBank },
    listQuestions: { arity: 1, run: banks.listQuestions },
    createQuestion: {
      arity: 1,
      run: (input) => {
        const question = banks.createQuestion(input)
        reminders.questionsAdded()
        return question
      },
    },
    updateQuestion: { arity: 1, run: banks.updateQuestion },
    deleteQuestion: { arity: 1, run: banks.deleteQuestion },
    importQuestionBank: {
      arity: 1,
      run: (input) => {
        const bank = banks.importQuestionBank(input)
        reminders.questionsAdded()
        return bank
      },
    },
    getReminderStatus: { arity: 0, run: () => reminders.status() },
    saveReminderSettings: {
      arity: 1,
      run: (input) => reminders.updateSettings(reminderSettings(input)),
    },
    pauseReminders: { arity: 1, run: (input) => reminders.pause(pauseOption(input)) },
    resumeReminders: { arity: 0, run: () => reminders.resume() },
    startLearning: { arity: 0, run: () => reminders.startLearning() },
    skipPendingLearning: { arity: 1, run: (input) => reminders.skipPending(sessionId(input)) },
    getAnswerView: { arity: 0, window: 'answer', run: () => reminders.answerView() },
    submitAnswer: {
      arity: 1,
      window: 'answer',
      run: (input) => reminders.submit(submitRequest(input)),
    },
    advanceAnswer: {
      arity: 1,
      window: 'answer',
      run: (input) => reminders.advance(sessionTarget(input)),
    },
    snoozeLearning: {
      arity: 1,
      window: 'answer',
      run: (input) => {
        const request = snoozeRequest(input)
        reminders.snooze(request.sessionId, request.minutes)
      },
    },
  }

  const methods = Object.keys(handlers) as (keyof InvokeApi)[]
  for (const method of methods) {
    const channel = IPC_CHANNELS[method]
    const { arity, run, window = 'main' } = handlers[method]
    ipcMain.handle(channel, (event, ...args: unknown[]) =>
      handleAppRequest<ApiResponse<typeof method>>(
        isTrusted(event, window),
        args,
        arity,
        run,
        (error) => console.error(`IPC ${channel} failed`, error),
      ),
    )
  }

  return () => {
    for (const method of methods) ipcMain.removeHandler(IPC_CHANNELS[method])
  }
}
