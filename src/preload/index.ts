import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { ApiResponse, InvokeApi, IpcResult, PingoApi } from '../shared/ipc'
import { REMINDER_EVENTS } from '../shared/reminders'
import type { ReminderEvents } from '../shared/reminders'

async function invoke<K extends keyof InvokeApi>(
  method: K,
  ...args: Parameters<InvokeApi[K]>
): Promise<ApiResponse<K>> {
  let result: IpcResult<ApiResponse<K>>
  try {
    result = await ipcRenderer.invoke(IPC_CHANNELS[method], ...args)
  } catch {
    throw new Error('无法连接桌面进程。')
  }
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function subscribe<K extends keyof ReminderEvents>(
  event: K,
  listener: (detail: ReminderEvents[K]) => void,
): () => void {
  const receiver = (_event: Electron.IpcRendererEvent, detail: ReminderEvents[K]) =>
    listener(detail)
  ipcRenderer.on(REMINDER_EVENTS[event], receiver)
  return () => {
    ipcRenderer.removeListener(REMINDER_EVENTS[event], receiver)
  }
}

const api: PingoApi = {
  getAppInfo: () => invoke('getAppInfo'),
  ping: () => invoke('ping'),
  listBanks: () => invoke('listBanks'),
  createBank: (input) => invoke('createBank', input),
  renameBank: (input) => invoke('renameBank', input),
  deleteBank: (input) => invoke('deleteBank', input),
  listQuestions: (input) => invoke('listQuestions', input),
  queryQuestions: (input) => invoke('queryQuestions', input),
  removeBankFavorite: (input) => invoke('removeBankFavorite', input),
  createQuestion: (input) => invoke('createQuestion', input),
  updateQuestion: (input) => invoke('updateQuestion', input),
  deleteQuestion: (input) => invoke('deleteQuestion', input),
  importQuestionBank: (json) => invoke('importQuestionBank', json),
  appendQuestionImport: (input) => invoke('appendQuestionImport', input),
  copyQuestionImportPrompt: (template) => invoke('copyQuestionImportPrompt', template),
  getReminderStatus: () => invoke('getReminderStatus'),
  saveReminderSettings: (settings) => invoke('saveReminderSettings', settings),
  pauseReminders: (option) => invoke('pauseReminders', option),
  resumeReminders: () => invoke('resumeReminders'),
  startLearning: () => invoke('startLearning'),
  skipPendingLearning: (sessionId) => invoke('skipPendingLearning', sessionId),
  getAnswerView: () => invoke('getAnswerView'),
  submitAnswer: (request) => invoke('submitAnswer', request),
  setAnswerFavorite: (request) => invoke('setAnswerFavorite', request),
  rateAnswer: (request) => invoke('rateAnswer', request),
  advanceAnswer: (target) => invoke('advanceAnswer', target),
  advanceStudyMaterial: (target) => invoke('advanceStudyMaterial', target),
  snoozeLearning: (request) => invoke('snoozeLearning', request),
  onReminderStatus: (listener) => subscribe('status', listener),
  onAnswerView: (listener) => subscribe('answer', listener),
}

contextBridge.exposeInMainWorld('pingo', api)
