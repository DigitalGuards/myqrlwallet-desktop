// Redirect Electron only in the native confirmation tests' Node process.
const mockUrl = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from 'node:events';
  export class BrowserWindow extends EventEmitter {
    webContents = new EventEmitter();
    getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  }
  export const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching() {
      return { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1024, height: 768 } };
    }
  });
  export const dialog = {
    async showMessageBox() { throw new Error('Unexpected native dialog'); }
  };
  export const utilityProcess = {
    fork() { throw new Error('Unexpected signer process'); }
  };
  export const app = {
    getPath() { throw new Error('Unexpected app path'); }
  };
  export default { BrowserWindow, dialog, utilityProcess, app, screen };
`)}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: mockUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
