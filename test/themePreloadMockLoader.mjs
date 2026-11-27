// The preload side of Electron for the theme preload tests: plain objects the
// test replaces method by method (t.mock.method) before importing a preload.
const mockUrl = `data:text/javascript,${encodeURIComponent(`
  export const contextBridge = { exposeInMainWorld() {} };
  export const ipcRenderer = {
    invoke() { return Promise.resolve(undefined); },
    on() {},
    removeListener() {},
    sendSync() { return undefined; },
  };
  export default { contextBridge, ipcRenderer };
`)}`;
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: mockUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
