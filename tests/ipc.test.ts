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
) {
  return registerIpc(
    runtime,
    isTrusted,
    createQuestionBankService(createQuestionBankRepository(database), randomUUID),
    scheduler,
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
