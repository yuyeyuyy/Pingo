# Pingo 架构

Pingo 是一款本地优先的桌面学习工具。当前版本支持本地题库管理、定时学习提醒和独立答题窗口。

## 本地开发

使用 Node.js 24.14 或更新的 24.x 版本。

```sh
npm install
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start
npm run package:mac
```

`dev` 通过 electron-vite 提供 React 热更新，并监听主进程和 Preload 文件。构建产物位于 `out/`，`start` 预览该产物。Electron 首次启动时会下载相应平台的运行时。macOS 打包命令会生成当前架构的 `dist/Pingo-darwin-<arch>/Pingo.app`，供本地运行和验证。

## 五层职责

| 层             | 目录                                                               | 职责                                                                   |
| -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Presentation   | `src/renderer`                                                     | React 显示题库、提醒设置、状态和独立答题窗口。Zustand 保存主窗口导航。 |
| IPC Bridge     | `src/preload`、`src/main/ipc`                                      | 公开最小桌面 API，集中注册 IPC Handler，验证发送方及参数并转换错误。   |
| Application    | `src/application`                                                  | 校验并编排题库操作。调度器管理提醒、学习会话和答题进度。               |
| Domain         | `src/domain`                                                       | 使用纯 TypeScript 表达题目、题库、学习会话、复习记录及提醒偏好。       |
| Infrastructure | `src/infrastructure/database`、`src/main/windows`、`src/main/tray` | 实现 SQLite、窗口、托盘、系统通知、电源事件和计时器。                  |

`src/main/index.ts` 和 `src/main/bootstrap` 组装进程生命周期、菜单和配置。 `src/shared/ipc.ts` 保存跨进程协议。表现层经 Preload API 与主进程通信，应用服务使用领域模型。领域层独立于其余模块，使用单独的 TypeScript 配置、Lint 规则和测试校验依赖。

## IPC 通信

```text
React 主窗口或答题窗口
  → window.pingo 中对应的方法
  → contextBridge
  → ipcRenderer.invoke() 使用固定通道
  → 集中注册的 ipcMain.handle()
  → 校验对应窗口、顶层 frame、页面 URL、参数数量和内容
  → 题库服务或提醒调度器 → SQLite
```

成功时，Preload 解包响应。失败时以异常通知调用者，主进程日志保留内部错误细节。题库操作在主进程校验字段、题型和题目所属题库。主窗口启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。答题窗口仅获授权读取当前会话、提交、前进和稍后提醒。主进程将状态发往对应窗口，预加载层负责订阅与清理。窗口限制页面导航和新窗口创建，生产页面使用打包内的文件和 CSP。

## 窗口与本地数据

- 主窗口通过关闭按钮或窗口菜单关闭时隐藏。再次点击 macOS Dock、选择托盘的「打开 Pingo」或启动第二个实例可恢复已有窗口。
- 「窗口」菜单和托盘均提供「开始 / 继续学习」。关闭答题窗口会跳过当前会话并保存已提交答案。
- 从应用菜单或托盘选择「退出 Pingo」会关闭窗口、移除 IPC Handler、销毁托盘并关闭数据库。
- SQLite 文件位于 Electron `userData` 下的 `pingo.sqlite`。主进程使用 Node 内置的 `node:sqlite`，避免额外原生扩展的 ABI 重编译。启动时通过事务应用迁移，使用 `PRAGMA user_version` 记录版本。第 1 版创建 `app_metadata`，第 2 版增加题库和题目表。第 3 版增加提醒状态与学习历史，保留已有题库。遇到高于当前版本的数据库时会保留文件并报错。
- macOS 专属行为位于桌面生命周期和窗口适配代码中。Windows 的窗口和托盘保留相应的 Electron 分支，当前交付以 macOS 为验证平台。

## 题库存储与导入

| SQLite 表        | 字段与约束                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `question_banks` | UUID 主键 `id`、名称 `name`。                                                                                                                                            |
| `questions`      | UUID 主键 `id`、外键 `bank_id`、题型 `kind` 和题干 `prompt`。选择题还存放有序数组 `options_json` 和从 0 开始的 `correct_option_index`。简答题可填写 `reference_answer`。 |

`questions.bank_id` 有索引。删除题库时，SQLite 通过外键级联删除所属题目。仓储使用参数化 SQL，导入用同一个事务创建题库及所有题目。

在「题库 → 导入 JSON」中选择 [示例文件](./example-question-bank.json)。文件顶层为 `name` 和 `questions`，每次导入创建一个新题库。采用 UTF-8 编码，单文件上限 4 MiB，包含 1 至 3,000 道题。

- 选择题使用 `kind: "multiple-choice"`，提供 `prompt`、2 至 20 个 `options` 和整数 `correctOptionIndex`。`0` 对应第一个选项。
- 简答题使用 `kind: "short-answer"`，提供 `prompt` 和可选的 `referenceAnswer`。
- 题目校验失败会显示文件中的题号，导入失败时不会落下部分数据。

## 定时提醒与答题

[调度器](../src/application/reminders/scheduler.ts)在 Electron 主进程运行。它通过注入的时钟、单次定时器、存储、题目来源和桌面适配器工作。每次状态变化取消旧定时器，并按持久化截止时间安排下一次检查。较长等候最多每 5 分钟重校一次墙上时钟，休眠时取消定时器。

| 调度状态         | 进入与退出条件                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `STOPPED`        | 关闭定时提醒。用户仍可通过菜单手动学习。                                                         |
| `WAITING`        | 启用、恢复、完成或跳过后，等待一个提醒间隔。题库为空时按间隔重试。                               |
| `DUE`            | 轻提醒已到期，或重启后有未完成会话。点击通知或应用内继续会打开同一个会话，忽略通知时保留这一轮。 |
| `SESSION_ACTIVE` | 答题窗口打开。提交的答案逐题持久化。完成或关闭后退出。                                           |
| `SNOOZED`        | 暂时隐藏答题窗口，保留相同会话、题目和提交进度。到期后按当前提醒模式继续。                       |
| `PAUSED`         | 暂停期间停止自动提醒。暂停至明天按本地次日零点计算。结束或手动恢复时重新计时。                   |

默认每 30 分钟、每次 3 题，使用轻提醒。间隔以分钟保存。等待期间调整间隔会从保存时重新计时。完成最后一题并点击「完成学习」，或关闭窗口跳过时，按当时的间隔计算下一次。暂停或关闭定时提醒期间可手动答题，稍后继续的会话会随提醒恢复而重新安排。

- 主动弹窗居中、独立且不持续置顶。默认通过 Electron 的 `showInactive()` 展示。勾选允许聚焦时才主动获取焦点。
- 轻提醒使用系统通知，点击与该会话绑定。系统权限或签名导致通知不可用时，主窗口和托盘仍提供继续入口。忽略通知不会派生额外会话。
- 每日勿扰使用本地时间，支持跨午夜。到期落在勿扰时段内会推迟到时段结束并重新校验。开启空闲勿扰时，锁屏或空闲满 5 分钟会顺延一个间隔，空闲状态未知时改用轻提醒。Electron 可识别 Pingo 自己的全屏窗口，开启全屏勿扰时遇到其他应用状态未知会降级成轻提醒。
- 唤醒或重启时，保留未来的有效截止时间和未到期的暂停。过期的普通提醒从当前时间重新计时。过期的稍后提醒重新校验后最多恢复一次。重启时正在答题的会话恢复为应用内待学习，待学习通知不会重发。
- 题目从现有 SQLite 题库随机抽样，同一轮不重复。会话保存题目快照，题库编辑不会改变当前轮次。单选题自动判分，简答题保留原答案与参考答案供自评。

`reminder_state` 保存设置、暂停截止、下次提醒和唯一未结束会话。确认完成或关闭窗口时，`learning_history` 保存有提交记录的会话，归档与清除当前会话在同一事务。未答题目不参与判分。

## 参考

- [electron-vite 开发与热更新](https://electron-vite.org/guide/hmr-and-hot-reloading)
- [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
- [Node.js SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Electron 电源和锁屏事件](https://www.electronjs.org/docs/latest/api/power-monitor)
- [Electron 系统通知与 macOS 签名](https://www.electronjs.org/docs/latest/api/notification)
