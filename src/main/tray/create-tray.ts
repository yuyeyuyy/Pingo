import { readFileSync } from 'node:fs'
import { Menu, nativeImage, Tray } from 'electron'
import iconPath from './assets/pingoTemplate.png?asset'
import icon2xPath from './assets/pingoTemplate@2x.png?asset'

export function createTray(actions: { openMain(): void; openAnswer(): void; quit(): void }): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(icon2xPath) })
  icon.setTemplateImage(process.platform === 'darwin')

  const tray = new Tray(icon)
  tray.setToolTip('Pingo')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Pingo', click: actions.openMain },
      { label: '开始 / 继续学习', click: actions.openAnswer },
      { type: 'separator' },
      { label: '退出 Pingo', click: actions.quit },
    ]),
  )
  if (process.platform !== 'darwin') tray.on('click', actions.openMain)
  return tray
}
