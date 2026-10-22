import { app, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { t } from './language';

/** Explicit labels also cover role items, whose OS defaults can use another language. */
export function applicationMenuTemplate(
  showSettings: () => void,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const settings: MenuItemConstructorOptions = {
    label: t('menu.settings'),
    accelerator: 'CmdOrCtrl+,',
    click: showSettings,
  };
  const about: MenuItemConstructorOptions = {
    label: t('menu.about'),
    click: () => {
      void dialog.showMessageBox({
        type: 'info',
        title: t('menu.about'),
        message: 'MyQRLWallet',
        detail: `${t('about.version', { version: app.getVersion() })}\n\n${t('about.description')}`,
        buttons: [t('common.ok')],
        noLink: true,
      });
    },
  };
  const quit: MenuItemConstructorOptions = { role: 'quit', label: t('menu.quit') };
  if (platform !== 'darwin') {
    return [{ label: t('menu.file'), submenu: [settings, about, { type: 'separator' }, quit] }];
  }
  return [
    {
      label: 'MyQRLWallet',
      submenu: [
        about,
        { type: 'separator' },
        settings,
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.unhide') },
        { type: 'separator' },
        quit,
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        { role: 'close', label: t('menu.close') },
        { type: 'separator' },
        { role: 'front', label: t('menu.front') },
      ],
    },
  ];
}

export function installApplicationMenu(showSettings: () => void): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(showSettings)));
}
