import { useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/ipc'
import { ReminderSettings } from '../components/reminders/ReminderSettings'
import { PronunciationSettings } from '../components/reminders/PronunciationSettings'

const platforms: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '无法连接桌面进程。'
}

export function SettingsPage() {
  const [info, setInfo] = useState<AppInfo>()
  const [infoError, setInfoError] = useState('')
  const [pinging, setPinging] = useState(false)
  const [pingResult, setPingResult] = useState('')
  const api = window.pingo

  useEffect(() => {
    if (!api) return
    let active = true
    void api
      .getAppInfo()
      .then((value) => {
        if (active) setInfo(value)
      })
      .catch((error: unknown) => {
        if (active) setInfoError(errorMessage(error))
      })
    return () => {
      active = false
    }
  }, [api])

  async function pingDesktop() {
    if (!api) return
    setPinging(true)
    setPingResult('')
    try {
      const reply = await api.ping()
      setPingResult(`连接正常 · ${reply}`)
    } catch (error) {
      setPingResult(errorMessage(error))
    } finally {
      setPinging(false)
    }
  }

  return (
    <>
      <header className="page-header">
        <h1 id="page-title">设置</h1>
        <p>应用信息与桌面行为。</p>
      </header>

      <PronunciationSettings />
      <ReminderSettings />

      <section className="settings-section" aria-labelledby="desktop-heading">
        <h2 id="desktop-heading">桌面应用</h2>
        <div className="settings-panel">
          {info ? (
            <dl className="settings-details">
              <div className="settings-row">
                <dt>版本</dt>
                <dd>{info.version}</dd>
              </div>
              <div className="settings-row">
                <dt>运行平台</dt>
                <dd>{platforms[info.platform] ?? info.platform}</dd>
              </div>
            </dl>
          ) : (
            <p className="settings-row" role="status">
              {api ? infoError || '正在读取应用信息…' : '请在 Pingo 桌面应用中查看版本与运行平台。'}
            </p>
          )}
          <div className="settings-row">
            <span>桌面连接</span>
            <button
              type="button"
              className="secondary-button"
              disabled={!api || pinging}
              onClick={pingDesktop}
            >
              {pinging ? '检测中…' : '测试连接'}
            </button>
          </div>
          {pingResult && (
            <p className="ping-result" role="status">
              {pingResult}
            </p>
          )}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="background-heading">
        <h2 id="background-heading">后台运行</h2>
        <p className="settings-note">
          关闭主窗口后，Pingo 会继续在后台运行。你可以从系统托盘重新打开窗口，或选择「退出
          Pingo」结束运行。
        </p>
      </section>
    </>
  )
}
