import type { PronunciationClip } from '../domain/pronunciation'
import type { PronunciationTarget } from '../domain/session'
import type {
  BankTemplate,
  BankLanguage,
  Question,
  QuestionBank,
  QuestionDraft,
  QuestionImportResult,
  QuestionPage,
  PracticeSource,
} from './question-bank'
import type {
  AnswerView,
  PauseOption,
  RateAnswerRequest,
  ReminderStatus,
  ReminderSettings,
  SetAnswerFavoriteRequest,
  SessionTarget,
  StudyMaterialTarget,
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
  createBank(input: {
    name: string
    template?: BankTemplate
    language?: BankLanguage
  }): Promise<QuestionBank>
  renameBank(input: { bankId: string; name: string }): Promise<QuestionBank>
  deleteBank(input: { bankId: string }): Promise<void>
  listQuestions(input: { bankId: string }): Promise<readonly Question[]>
  queryQuestions(input: {
    bankId: string
    query: string
    page: number
    source?: PracticeSource
  }): Promise<QuestionPage>
  removeBankFavorite(input: { bankId: string; questionId: string }): Promise<void>
  createQuestion(input: { bankId: string; question: QuestionDraft }): Promise<Question>
  updateQuestion(input: {
    bankId: string
    questionId: string
    question: QuestionDraft
  }): Promise<Question>
  deleteQuestion(input: { bankId: string; questionId: string }): Promise<void>
  importQuestionBank(json: string): Promise<QuestionBank>
  appendQuestionImport(input: { bankId: string; json: string }): Promise<QuestionImportResult>
  copyQuestionImportPrompt(template: BankTemplate): Promise<void>
  getReminderStatus(): Promise<ReminderStatus>
  saveReminderSettings(settings: ReminderSettings): Promise<ReminderStatus>
  pauseReminders(option: PauseOption): Promise<ReminderStatus>
  resumeReminders(): Promise<ReminderStatus>
  startLearning(): Promise<ReminderStatus>
  skipPendingLearning(sessionId: string): Promise<ReminderStatus>
  getAnswerView(): Promise<AnswerView>
  getPronunciation(target: PronunciationTarget): Promise<PronunciationClip | null>
  submitAnswer(request: SubmitAnswerRequest): Promise<AnswerView>
  setAnswerFavorite(request: SetAnswerFavoriteRequest): Promise<AnswerView>
  rateAnswer(request: RateAnswerRequest): Promise<AnswerView>
  advanceAnswer(target: SessionTarget): Promise<AnswerView>
  advanceStudyMaterial(target: StudyMaterialTarget): Promise<AnswerView>
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
  queryQuestions: 'bank:query-questions',
  removeBankFavorite: 'bank:remove-favorite',
  createQuestion: 'bank:create-question',
  updateQuestion: 'bank:update-question',
  deleteQuestion: 'bank:delete-question',
  importQuestionBank: 'bank:import-json',
  appendQuestionImport: 'bank:append-json',
  copyQuestionImportPrompt: 'bank:copy-import-prompt',
  getReminderStatus: 'reminder:get-status',
  saveReminderSettings: 'reminder:save-settings',
  pauseReminders: 'reminder:pause',
  resumeReminders: 'reminder:resume',
  startLearning: 'learning:start',
  skipPendingLearning: 'learning:skip-pending',
  getAnswerView: 'learning:get-view',
  getPronunciation: 'learning:pronunciation',
  submitAnswer: 'learning:submit',
  setAnswerFavorite: 'learning:set-favorite',
  rateAnswer: 'learning:rate-answer',
  advanceAnswer: 'learning:advance',
  advanceStudyMaterial: 'learning:advance-material',
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
