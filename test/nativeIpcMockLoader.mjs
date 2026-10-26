// Real IPC/store/preload modules, with Electron UI and user approval as test doubles.
const electron = `
import { EventEmitter } from 'node:events';
const contents = [], windows = [];
class Contents extends EventEmitter {
  mainFrame = { url: 'app://wallet/index.html' };
  destroyed = false;
  constructor() { super(); contents.push(this); }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.mainFrame.url; }
  send() {}
  focus() {}
  reload() {}
  close() { this.destroyed = true; }
  async loadFile(file) { this.mainFrame.url = 'file://' + file; this.emit('did-finish-load'); }
  async loadURL(url) { this.mainFrame.url = url; this.emit('did-finish-load'); }
}
export class BrowserWindow extends EventEmitter {
  webContents = new Contents();
  visible = true;
  destroyed = false;
  contentView = { children: [], addChildView(view) { this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(v => v !== view); } };
  constructor() { super(); windows.push(this); }
  static getAllWindows() { return windows.filter(w => !w.destroyed); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return true; }
  isMinimized() { return false; }
  focus() {}
  flashFrame() {}
  setTitle() {}
  getBounds() { return { x: 0, y: 0, width: 1024, height: 768 }; }
  getContentSize() { return [1024, 768]; }
  hide() { this.visible = false; }
  show() { this.visible = true; }
  showInactive() { this.visible = true; }
  close() { this.emit('close'); this.destroyed = true; this.webContents.close(); this.emit('closed'); }
  async loadFile(file) { await this.webContents.loadFile(file); this.emit('ready-to-show'); }
  async loadURL(url) { await this.webContents.loadURL(url); this.emit('ready-to-show'); }
}
export class WebContentsView {
  webContents = new Contents();
  setBackgroundColor() {}
  setBounds() {}
}
export const webContents = { getAllWebContents: () => contents };
export const ipcMain = { handle() {} };
export const ipcRenderer = { invoke() {}, on() {}, removeListener() {} };
export const contextBridge = { exposeInMainWorld() {} };
export const shell = { async openPath() { return ''; } };
export const dialog = {};
export const screen = new EventEmitter();
export const utilityProcess = { fork() { throw new Error('Unexpected signer process'); } };
export const app = { name: 'MyQRLWallet', isPackaged: true, getVersion() { return 'test'; }, getPath() { throw new Error('Unexpected path'); }, quit() {} };
export default { app };
`;
const approval = `export async function confirmSignature() { return true; }
export async function confirmRemoveWallet() { return true; }
export function abortPendingConfirms() {}`;
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron')
    return { url: 'data:text/javascript,' + encodeURIComponent(electron), shortCircuit: true };
  if (specifier === './confirm' && context.parentURL?.includes('/src/main/'))
    return { url: 'data:text/javascript,' + encodeURIComponent(approval), shortCircuit: true };
  if (specifier.endsWith('?asset'))
    return { url: 'data:text/javascript,export default "icon.png"', shortCircuit: true };
  return nextResolve(specifier, context);
}
