/** Private startup helper: no contextBridge API and no frontend code. */
import { ipcRenderer } from 'electron';
import { STORAGE_MIGRATION_URL } from '../shared/appUrls';
import {
  STORAGE_MIGRATION_CHANNEL,
  LEGACY_STORAGE_MIGRATION_URL,
  isStorageEntries,
  type StorageEntries,
} from '../shared/storageMigration';

async function migrate(): Promise<void> {
  if (location.href === LEGACY_STORAGE_MIGRATION_URL) {
    const entries: StorageEntries = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) {
        const value = localStorage.getItem(key);
        if (value !== null) entries.push([key, value]);
      }
    }
    await ipcRenderer.invoke(STORAGE_MIGRATION_CHANNEL, { step: 'read', entries });
  } else if (location.href === STORAGE_MIGRATION_URL) {
    const raw: unknown = await ipcRenderer.invoke(STORAGE_MIGRATION_CHANNEL, { step: 'write' });
    if (!isStorageEntries(raw)) throw new Error('invalid storage snapshot');
    const entries = raw;
    const written: StorageEntries = [];
    for (const [key, value] of entries) {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
        written.push([key, value]);
      }
    }
    for (const [key] of entries) {
      if (localStorage.getItem(key) === null) throw new Error('storage copy failed');
    }
    for (const [key, value] of written) {
      if (localStorage.getItem(key) !== value) throw new Error('storage copy failed');
    }
    await ipcRenderer.invoke(STORAGE_MIGRATION_CHANNEL, { step: 'complete' });
  }
}

window.addEventListener(
  'DOMContentLoaded',
  () => {
    void migrate().catch(() => {
      // Report only a fixed status. Keys, values and exception details stay private.
      void ipcRenderer.invoke(STORAGE_MIGRATION_CHANNEL, { step: 'failed' }).catch(() => undefined);
    });
  },
  { once: true },
);
