// Redirect Electron only in the native confirmation tests' Node process.
const mockUrl = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from 'node:events';
  export class BrowserWindow extends EventEmitter {
    webContents = new EventEmitter();
  }
  export const dialog = {
    async showMessageBox() { throw new Error('Unexpected native dialog'); }
  };
  export const utilityProcess = {
    fork() { throw new Error('Unexpected signer process'); }
  };
  export const app = {
    name: 'MyQRLWallet',
    getPath() { throw new Error('Unexpected app path'); }
  };
  export const Menu = {
    buildFromTemplate() { throw new Error('Unexpected native menu'); }
  };
  export default { BrowserWindow, dialog, utilityProcess, app };
`)}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: mockUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
