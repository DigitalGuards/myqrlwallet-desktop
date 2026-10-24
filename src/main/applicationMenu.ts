import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { t } from './language';

/** Preserve native role behavior and system localization; translate custom items. */
export function applicationMenuTemplate(
  showSettings: () => void,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const settings: MenuItemConstructorOptions = {
    label: t('menu.settings'),
    accelerator: 'CmdOrCtrl+,',
    click: showSettings,
  };
  if (platform !== 'darwin') {
    return [
      { label: t('menu.file'), submenu: [settings, { type: 'separator' }, { role: 'quit' }] },
    ];
  }
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settings,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
}

export function installApplicationMenu(showSettings: () => void): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(showSettings)));
}
