# Pingo

Pingo 是一款本地优先的 macOS 桌面学习工具。导入或创建自己的题库后，Pingo 可以按设定间隔提醒你答几道题。

- 管理题库、搜索题干，批量导入 JSON 格式的单选题和简答题。
- 选择系统通知或独立弹窗，设置间隔、每轮题量、暂停和勿扰时段。
- 稍后提醒会保留本轮进度。设置、题库和已提交的答案保存在本机 SQLite 数据库中。

## 从源码运行

需要 Node.js 24.14 或更新的 24.x 版本。测试中的词库转换脚本另需 Python 3.9 或更新版本。

```sh
npm ci
npm run dev
```

在「题库 → 导入 JSON」选择[示例题库](docs/example-question-bank.json)，然后从「设置 → 学习提醒」点击「立即学习」。关闭主窗口后应用继续在后台运行，从应用菜单或托盘选择「退出 Pingo」可结束运行。

## 检查与打包

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run package:mac
```

打包命令在 `dist/Pingo-darwin-<arch>/Pingo.app` 生成本机架构的应用。更多说明见[架构文档](docs/ARCHITECTURE.md)和 [CET4 词库转换说明](docs/cet4-converter.md)。转换用的原始词库和生成数据由使用者在本机提供。
