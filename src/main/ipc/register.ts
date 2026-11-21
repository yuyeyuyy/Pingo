import { clipboard, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { getAppInfo } from '../../application/app-info'
import type { AppRuntime } from '../../application/app-info'
import type { QuestionBankService } from '../../application/question-bank/service'
import { bankTemplate } from '../../application/question-bank/validation'
import type { SchedulerService } from '../../application/reminders/scheduler'
import type { PronunciationService } from '../../application/pronunciation'
import { RequestError } from '../../application/request-error'
import { pronunciationForView } from '../../domain/session'
import {
  pauseOption,
  pronunciationTarget,
  rateAnswerRequest,
  reminderSettings,
  sessionId,
  sessionTarget,
  setAnswerFavoriteRequest,
  studyMaterialTarget,
  snoozeRequest,
  submitRequest,
} from '../../application/reminders/validation'
import { IPC_CHANNELS } from '../../shared/ipc'
import { conversionPrompt } from '../../shared/question-import-prompt'
import type { ApiResponse, InvokeApi } from '../../shared/ipc'
import { handleAppRequest } from './app-request'

export function registerIpc(
  runtime: AppRuntime,
  isTrusted: (event: IpcMainInvokeEvent, window: 'main' | 'answer') => boolean,
  banks: QuestionBankService,
  reminders: SchedulerService,
  pronunciation: PronunciationService,
) {
  const handlers: {
    [K in keyof InvokeApi]: {
      arity: Parameters<InvokeApi[K]>['length']
      window?: 'answer'
      run: (...args: unknown[]) => ApiResponse<K> | Promise<ApiResponse<K>>
    }
  } = {
    getAppInfo: { arity: 0, run: () => getAppInfo(runtime) },
    ping: { arity: 0, run: () => 'pong' },
    listBanks: { arity: 0, run: banks.listBanks },
    createBank: { arity: 1, run: banks.createBank },
    renameBank: { arity: 1, run: banks.renameBank },
    deleteBank: {
      arity: 1,
      run: (input) => {
        banks.deleteBank(input)
        reminders.reviewsChanged()
      },
    },
    listQuestions: { arity: 1, run: banks.listQuestions },
    queryQuestions: { arity: 1, run: banks.queryQuestions },
    removeBankFavorite: {
      arity: 1,
      run: (input) => {
        banks.removeFavorite(input)
        reminders.reviewsChanged()
      },
    },
    createQuestion: {
      arity: 1,
      run: (input) => {
        const question = banks.createQuestion(input)
        reminders.questionsAdded()
        return question
      },
    },
    updateQuestion: {
      arity: 1,
      run: (input) => {
        const question = banks.updateQuestion(input)
        reminders.reviewsChanged()
        return question
      },
    },
    deleteQuestion: {
      arity: 1,
      run: (input) => {
        banks.deleteQuestion(input)
        reminders.reviewsChanged()
      },
    },
    importQuestionBank: {
      arity: 1,
      run: (input) => {
        const bank = banks.importQuestionBank(input)
        reminders.questionsAdded()
        return bank
      },
    },
    appendQuestionImport: {
      arity: 1,
      run: (input) => {
        const result = banks.appendQuestionImport(input)
        reminders.questionsAdded()
        return result
      },
    },
    copyQuestionImportPrompt: {
      arity: 1,
      run: (template) => clipboard.writeText(conversionPrompt(bankTemplate(template))),
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
    getPronunciation: {
      arity: 1,
      window: 'answer',
      run(input) {
        const target = pronunciationTarget(input)
        const view = reminders.answerView()
        if (!view || view.kind === 'summary' || view.sessionId !== target.sessionId)
          throw new RequestError('NOT_FOUND', '当前学习内容已切换。')
        const matches =
          'position' in target
            ? view.kind === 'material' && view.position === target.position
            : view.kind === 'question' && view.question.id === target.questionId
        if (!matches) throw new RequestError('NOT_FOUND', '当前学习内容已切换。')
        const lookup = pronunciationForView(
          view,
          'optionIndex' in target ? target.optionIndex : undefined,
        )
        if (!lookup) throw new RequestError('INVALID_ARGUMENTS', '此处没有可播放的发音。')
        return pronunciation(lookup.language, lookup.word)
      },
    },
    submitAnswer: {
      arity: 1,
      window: 'answer',
      run: (input) => reminders.submit(submitRequest(input)),
    },
    setAnswerFavorite: {
      arity: 1,
      window: 'answer',
      run: (input) => reminders.setFavorite(setAnswerFavoriteRequest(input)),
    },
    rateAnswer: {
      arity: 1,
      window: 'answer',
      run: (input) => reminders.rateAnswer(rateAnswerRequest(input)),
    },
    advanceAnswer: {
      arity: 1,
      window: 'answer',
      run: (input) => reminders.advance(sessionTarget(input)),
    },
    advanceStudyMaterial: {
      arity: 1,
      window: 'answer',
      run: (input) => reminders.advanceStudyMaterial(studyMaterialTarget(input)),
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
