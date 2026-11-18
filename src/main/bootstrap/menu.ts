import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

export function installApplicationMenu(actions: { openAnswer(): void; quit(): void }): void {
  const macAppActions: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }]
      : []

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Pingo',
      submenu: [
        { label: '关于 Pingo', role: 'about' },
        { type: 'separator' },
        ...macAppActions,
        { label: '退出 Pingo', accelerator: 'CommandOrControl+Q', click: actions.quit },
      ],
    },
    { label: '编辑', role: 'editMenu' },
    {
      label: '窗口',
      role: 'window',
      submenu: [
        { label: '开始 / 继续学习', click: actions.openAnswer },
        { type: 'separator' },
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
