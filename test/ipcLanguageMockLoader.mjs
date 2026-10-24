const mockUrl = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from 'node:events';
  export class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'app://wallet/index.html' } });
    isDestroyed() { return false; }
  }
  export class WebContentsView {}
  export const ipcMain = { handle() {} };
  export const shell = {};
  export const dialog = { async showMessageBox() { throw new Error('Unexpected dialog'); } };
  export const screen = new EventEmitter();
  export const utilityProcess = { fork() { throw new Error('Unexpected signer'); } };
  export const app = { name: 'MyQRLWallet', isPackaged: true, getPath() { throw new Error('Unexpected app path'); } };
  export const Menu = { buildFromTemplate() { throw new Error('Unexpected native menu'); } };
  export default { BrowserWindow, WebContentsView, ipcMain, shell, dialog, app };
`)}`;
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: mockUrl, shortCircuit: true };
  if (specifier.endsWith('?asset'))
    return { url: 'data:text/javascript,export default "icon.png"', shortCircuit: true };
  return nextResolve(specifier, context);
}
