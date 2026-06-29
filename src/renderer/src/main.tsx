/**
 * Renderer entry point.
 *
 * This is the bundled demo/reference renderer. It runs in a sandboxed,
 * context-isolated renderer with NO Node access: the ONLY capability it has is
 * `window.qrlWallet`, the narrow contextBridge surface mounted by the preload.
 * Everything below consumes that surface and nothing else (no ipcRenderer, no
 * require, no fetch to arbitrary hosts).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
