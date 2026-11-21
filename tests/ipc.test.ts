import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuestionBankService } from '../src/application/question-bank/service'
import { openDatabase } from '../src/infrastructure/database/open'
import { createQuestionBankRepository } from '../src/infrastructure/database/question-bank-repository'
import { registerIpc } from '../src/main/ipc/register'
import { IPC_CHANNELS } from '../src/shared/ipc'
import { schedulerFixture } from './helpers/reminders'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}))

const event = {} as IpcMainInvokeEvent
let directory: string
let database: ReturnType<typeof openDatabase>

function register(
  runtime: Parameters<typeof registerIpc>[0],
  isTrusted: Parameters<typeof registerIpc>[1],
  scheduler = schedulerFixture().create(),
  pronunciation = vi.fn().mockResolvedValue(null),
) {
  return registerIpc(
    runtime,
    isTrusted,
    createQuestionBankService(createQuestionBankRepository(database), randomUUID),
    scheduler,
    pronunciation,
  )
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const registration = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
  if (!registration) throw new Error(`Missing IPC registration for ${channel}`)
  return registration[1](event, ...args)
}

describe('app IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    directory = mkdtempSync(join(tmpdir(), 'pingo-ipc-'))
    database = openDatabase(directory)
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('registers the metadata and ping handlers and removes both on teardown', () => {
    const unregister = register(
      { getVersion: () => '0.1.0', platform: 'darwin' },
      (sender) => sender === event,
    )

    expect(invoke(IPC_CHANNELS.getAppInfo)).toEqual({
      ok: true,
      data: { version: '0.1.0', platform: 'darwin' },
    })
    expect(invoke(IPC_CHANNELS.ping)).toEqual({ ok: true, data: 'pong' })

    unregister()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(Object.keys(IPC_CHANNELS).length)
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getAppInfo)
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.ping)
  })

  it('denies an untrusted sender before reading runtime details', () => {
    const getVersion = vi.fn(() => '0.1.0')
    register({ getVersion, platform: 'darwin' }, () => false)

    expect(invoke(IPC_CHANNELS.getAppInfo)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(getVersion).not.toHaveBeenCalled()
  })

  it.each([IPC_CHANNELS.getAppInfo, IPC_CHANNELS.ping, IPC_CHANNELS.listBanks])(
    'rejects extra arguments on %s',
    (channel) => {
      register({ getVersion: () => '0.1.0', platform: 'darwin' }, () => true)

      expect(invoke(channel, undefined)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_ARGUMENTS' },
      })
    },
  )

  it('validates bank requests and returns expected errors without a mutation', () => {
    register({ getVersion: () => '0.1.0', platform: 'darwin' }, () => true)

    expect(invoke(IPC_CHANNELS.createBank)).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } })
    expect(invoke(IPC_CHANNELS.createBank, { name: 1 })).toMatchObject({
      error: { code: 'INVALID_ARGUMENTS' },
    })
    expect(invoke(IPC_CHANNELS.listQuestions, { bankId: randomUUID() })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
    expect(invoke(IPC_CHANNELS.listBanks)).toEqual({ ok: true, data: [] })
  })

  it('validates reminder inputs and authorizes answer channels only from the answer window', () => {
    const fixture = schedulerFixture()
    const scheduler = fixture.create()
    register(
      { getVersion: () => '0.1.0', platform: 'darwin' },
      (_sender, scope) => scope === 'main',
      scheduler,
    )
    expect(
      invoke(IPC_CHANNELS.saveReminderSettings, {
        ...scheduler.status().settings,
        intervalMinutes: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } })
    expect(invoke(IPC_CHANNELS.getAnswerView)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(
      invoke(IPC_CHANNELS.getPronunciation, { sessionId: 'session', questionId: 'q' }),
    ).toMatchObject({
      error: { code: 'FORBIDDEN' },
    })
    expect(
      invoke(IPC_CHANNELS.advanceStudyMaterial, { sessionId: 'session', position: 1 }),
    ).toMatchObject({
      error: { code: 'FORBIDDEN' },
    })
    expect(
      invoke(IPC_CHANNELS.saveReminderSettings, {
        ...scheduler.status().settings,
        sessionMode: 'unknown',
      }),
    ).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } })
    expect(scheduler.status().settings.intervalMinutes).toBe(30)
  })

  it('validates pronunciation preferences and saves valid values from the main window', () => {
    const scheduler = schedulerFixture().create()
    register(
      { getVersion: () => '0.1.0', platform: 'darwin' },
      (_event, scope) => scope === 'main',
      scheduler,
    )
    const preferences = { voiceURI: 'local://voice', rate: 0.9, source: 'system' } as const
    for (const malformed of [
      { ...preferences, rate: 0.5 },
      { ...preferences, source: 'remote' },
      { ...preferences, voiceURI: ' ' },
    ]) {
      expect(invoke(IPC_CHANNELS.savePronunciationPreferences, malformed)).toMatchObject({
        error: { code: 'INVALID_ARGUMENTS' },
      })
    }
    expect(scheduler.status().pronunciation).toBeUndefined()
    expect(invoke(IPC_CHANNELS.savePronunciationPreferences, preferences)).toMatchObject({
      ok: true,
      data: { pronunciation: preferences },
    })
  })

  it('only resolves pronunciation for the current visible word and awaits the adapter', async () => {
    const scheduler = schedulerFixture({
      questions: () => [
        {
          id: 'q',
          bankName: '词表',
          kind: 'multiple-choice',
          languageType: 'word-to-meaning',
          prompt: 'hello 的意思是什么？',
          options: ['你好', '再见'],
          correctOptionIndex: 0,
          optionExplanations: ['hello', 'goodbye'],
        },
      ],
    }).create()
    const clip = { mimeType: 'audio/mpeg', bytes: new Uint8Array([1, 2]).buffer }
    const lookup = vi.fn().mockResolvedValue(clip)
    register({ getVersion: () => '0.1.0', platform: 'darwin' }, () => true, scheduler, lookup)
    scheduler.start()
    try {
      scheduler.startLearning()
      const view = scheduler.answerView()
      if (view?.kind !== 'question') throw new Error('expected a question')
      const target = { sessionId: view.sessionId, questionId: view.question.id }
      expect(invoke(IPC_CHANNELS.getPronunciation, { ...target, optionIndex: 1 })).toMatchObject({
        error: { code: 'INVALID_ARGUMENTS' },
      })
      expect(
        invoke(IPC_CHANNELS.getPronunciation, { ...target, questionId: 'stale' }),
      ).toMatchObject({ error: { code: 'NOT_FOUND' } })
      expect(lookup).not.toHaveBeenCalled()
      await expect(invoke(IPC_CHANNELS.getPronunciation, target)).resolves.toEqual({
        ok: true,
        data: clip,
      })
      expect(lookup).toHaveBeenCalledWith('en', 'hello')
      scheduler.submit({ ...target, answer: { kind: 'multiple-choice', optionIndex: 0 } })
      await expect(
        invoke(IPC_CHANNELS.getPronunciation, { ...target, optionIndex: 1 }),
      ).resolves.toEqual({ ok: true, data: clip })
      expect(lookup).toHaveBeenLastCalledWith('en', 'goodbye')
    } finally {
      scheduler.stop()
    }
  })

  it('pronounces only the current study card and routes by that card’s language', async () => {
    const scheduler = schedulerFixture({
      questions: () => [
        { id: 'en', bankName: '英语', kind: 'short-answer', language: 'en', prompt: '填空' },
        { id: 'ja', bankName: '日语', kind: 'short-answer', language: 'ja', prompt: '填空' },
      ],
      studyMaterials: () => [
        { key: 'hello', title: 'Hello', bankName: '英语', explanation: '你好', examples: [] },
        {
          key: 'hello-ja',
          title: 'こんにちは',
          language: 'ja',
          bankName: '日语',
          explanation: '你好',
          examples: [],
        },
      ],
    }).create()
    const lookup = vi.fn().mockResolvedValue(null)
    register({ getVersion: () => '0.1.0', platform: 'darwin' }, () => true, scheduler, lookup)
    scheduler.start()
    try {
      scheduler.updateSettings({ ...scheduler.status().settings, sessionMode: 'study' })
      scheduler.startLearning()
      const view = scheduler.answerView()
      if (view?.kind !== 'material') throw new Error('expected a material')
      const target = { sessionId: view.sessionId, position: 1 }
      expect(invoke(IPC_CHANNELS.getPronunciation, { ...target, position: 2 })).toMatchObject({
        error: { code: 'NOT_FOUND' },
      })
      expect(invoke(IPC_CHANNELS.getPronunciation, { ...target, optionIndex: 0 })).toMatchObject({
        error: { code: 'INVALID_ARGUMENTS' },
      })
      await expect(invoke(IPC_CHANNELS.getPronunciation, target)).resolves.toEqual({
        ok: true,
        data: null,
      })
      expect(lookup).toHaveBeenCalledExactlyOnceWith('en', 'hello')
      scheduler.advanceStudyMaterial(target)
      expect(invoke(IPC_CHANNELS.getPronunciation, target)).toMatchObject({
        error: { code: 'NOT_FOUND' },
      })
      expect(invoke(IPC_CHANNELS.getPronunciation, { ...target, position: 2 })).toMatchObject({
        error: { code: 'INVALID_ARGUMENTS' },
      })
      expect(lookup).toHaveBeenCalledOnce()
    } finally {
      scheduler.stop()
    }
  })

  it('reuses the active session when the same start IPC is invoked repeatedly', () => {
    const fixture = schedulerFixture()
    const scheduler = fixture.create()
    register({ getVersion: () => '0.1.0', platform: 'darwin' }, () => true, scheduler)
    scheduler.start()
    try {
      expect(
        invoke(IPC_CHANNELS.advanceStudyMaterial, { sessionId: 'session', position: 0 }),
      ).toMatchObject({
        error: { code: 'INVALID_ARGUMENTS' },
      })
      invoke(IPC_CHANNELS.startLearning)
      const original = invoke(IPC_CHANNELS.getAnswerView)
      invoke(IPC_CHANNELS.startLearning)
      invoke(IPC_CHANNELS.startLearning)
      expect(invoke(IPC_CHANNELS.getAnswerView)).toEqual(original)
      expect(fixture.source).toHaveBeenCalledOnce()
    } finally {
      scheduler.stop()
    }
  })

  it('logs internal failures while returning a generic error to the caller', () => {
    const error = new Error('private runtime detail')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      register(
        {
          getVersion: () => {
            throw error
          },
          platform: 'darwin',
        },
        () => true,
      )

      expect(invoke(IPC_CHANNELS.getAppInfo)).toEqual({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '桌面进程处理请求失败。' },
      })
      expect(log).toHaveBeenCalledWith(expect.any(String), error)
    } finally {
      log.mockRestore()
    }
  })
})
