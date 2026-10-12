// Redirect Electron only in the native confirmation tests' Node process.
const mockUrl = `data:text/javascript,${encodeURIComponent(`
  export class BrowserWindow {}
  export const dialog = {
    async showMessageBox() { throw new Error('Unexpected native dialog'); }
  };
`)}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: mockUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
