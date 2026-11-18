import type { Question, QuestionBank, QuestionDraft } from './question-bank'
import type {
  AnswerView,
  PauseOption,
  ReminderStatus,
  ReminderSettings,
  SessionTarget,
  SubmitAnswerRequest,
} from './reminders'

export interface AppInfo {
  version: string
  platform: string
}

/** The public API available to React through window.pingo. */
export interface PingoApi {
  getAppInfo(): Promise<AppInfo>
  ping(): Promise<'pong'>
  listBanks(): Promise<readonly QuestionBank[]>
  createBank(input: { name: string }): Promise<QuestionBank>
  renameBank(input: { bankId: string; name: string }): Promise<QuestionBank>
  deleteBank(input: { bankId: string }): Promise<void>
  listQuestions(input: { bankId: string }): Promise<readonly Question[]>
  createQuestion(input: { bankId: string; question: QuestionDraft }): Promise<Question>
  updateQuestion(input: {
    bankId: string
    questionId: string
    question: QuestionDraft
  }): Promise<Question>
  deleteQuestion(input: { bankId: string; questionId: string }): Promise<void>
  importQuestionBank(json: string): Promise<QuestionBank>
  getReminderStatus(): Promise<ReminderStatus>
  saveReminderSettings(settings: ReminderSettings): Promise<ReminderStatus>
  pauseReminders(option: PauseOption): Promise<ReminderStatus>
  resumeReminders(): Promise<ReminderStatus>
  startLearning(): Promise<ReminderStatus>
  skipPendingLearning(sessionId: string): Promise<ReminderStatus>
  getAnswerView(): Promise<AnswerView>
  submitAnswer(request: SubmitAnswerRequest): Promise<AnswerView>
  advanceAnswer(target: SessionTarget): Promise<AnswerView>
  snoozeLearning(request: { sessionId: string; minutes: number }): Promise<void>
  onReminderStatus(listener: (status: ReminderStatus) => void): () => void
  onAnswerView(listener: (view: AnswerView) => void): () => void
}

export type InvokeApi = Omit<PingoApi, 'onReminderStatus' | 'onAnswerView'>

export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  ping: 'app:ping',
  listBanks: 'bank:list',
  createBank: 'bank:create',
  renameBank: 'bank:rename',
  deleteBank: 'bank:delete',
  listQuestions: 'bank:list-questions',
  createQuestion: 'bank:create-question',
  updateQuestion: 'bank:update-question',
  deleteQuestion: 'bank:delete-question',
  importQuestionBank: 'bank:import-json',
  getReminderStatus: 'reminder:get-status',
  saveReminderSettings: 'reminder:save-settings',
  pauseReminders: 'reminder:pause',
  resumeReminders: 'reminder:resume',
  startLearning: 'learning:start',
  skipPendingLearning: 'learning:skip-pending',
  getAnswerView: 'learning:get-view',
  submitAnswer: 'learning:submit',
  advanceAnswer: 'learning:advance',
  snoozeLearning: 'learning:snooze',
} as const satisfies Record<keyof InvokeApi, string>

export type ApiResponse<K extends keyof InvokeApi> = Awaited<ReturnType<InvokeApi[K]>>

export type IpcResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      error: {
        code: 'FORBIDDEN' | 'INVALID_ARGUMENTS' | 'NOT_FOUND' | 'INTERNAL_ERROR'
        message: string
      }
    }
