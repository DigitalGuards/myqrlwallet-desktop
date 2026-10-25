import { readFileSync } from 'node:fs';
import { z } from 'zod';
import path from 'node:path';
import { BrowserWindow, ipcMain, session } from 'electron';
import { STORAGE_MIGRATION_URL } from '../shared/appUrls';
import {
  LEGACY_STORAGE_MIGRATION_URL,
  STORAGE_MIGRATION_CHANNEL,
  type StorageEntries,
} from '../shared/storageMigration';
import { securityHeaders } from './appProtocol';
import { hardenedWebPreferences } from './security';
import { readSettings, updateSettings } from './settingsFile';
import { logMain } from './log';

const MigrationMessageSchema = z.discriminatedUnion('step', [
  z.strictObject({
    step: z.literal('read'),
    entries: z.array(z.tuple([z.string(), z.string()])),
  }),
  z.strictObject({ step: z.literal('write') }),
  z.strictObject({ step: z.literal('complete') }),
  z.strictObject({ step: z.literal('failed') }),
]);

/** Deny file requests, with one main-frame helper exception during startup. */
export function installFileAccessPolicy(csp: string): (window: BrowserWindow | null) => void {
  let helper: BrowserWindow | null = null;
  let helperHtml: string | undefined;
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    callback({
      cancel:
        !helper ||
        helper.isDestroyed() ||
        details.webContentsId !== helper.webContents.id ||
        details.resourceType !== 'mainFrame' ||
        details.url !== LEGACY_STORAGE_MIGRATION_URL,
    });
  });
  ses.protocol.handle('file', (request) => {
    const headers = securityHeaders(csp);
    if (
      !helper ||
      helper.isDestroyed() ||
      !helperHtml ||
      request.url !== LEGACY_STORAGE_MIGRATION_URL ||
      request.method !== 'GET'
    ) {
      return new Response(null, { status: 403, headers });
    }
    // The legacy URL only receives this inert page. Never serve the frontend at file:.
    headers.set(
      'Content-Security-Policy',
      `${csp}, default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(helperHtml, { headers });
  });
  return (window) => {
    // Development-server mode needs no built wallet bundle or migration page.
    helperHtml = window
      ? readFileSync(path.join(__dirname, '../renderer/storage-migration.html'), 'utf8')
      : undefined;
    helper = window;
  };
}

/** Attempt the copy before the UI opens. Failures leave startup available and retry next launch. */
export async function migrateWalletStorage(
  allowHelper: ReturnType<typeof installFileAccessPolicy>,
): Promise<void> {
  try {
    await copyWalletStorage(allowHelper);
  } catch {
    // Never forward errors from storage or IPC: they may contain stored keys or values.
    logMain('[storage] wallet origin migration failed; will retry next launch');
  }
}

async function copyWalletStorage(
  allowHelper: ReturnType<typeof installFileAccessPolicy>,
): Promise<void> {
  if ((await readSettings()).walletOriginMigrationV1 === true) return;
  const createHelper = (legacyReader: boolean) =>
    new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        ...hardenedWebPreferences(path.join(__dirname, '../preload/storageMigration.js')),
        devTools: false,
        // Electron 44 denies file-origin localStorage with the file fuse off.
        // Only this inert, startup-only reader gets the compatibility setting.
        // Its no-resource CSP and main-frame-only file filter remain enforced.
        // Destroy it before creating the fully hardened destination helper/UI.
        webSecurity: !legacyReader,
      },
    });
  let helper: BrowserWindow | undefined;
  let phase: 'read' | 'write' | 'complete' = 'read';
  let entries: StorageEntries = [];
  let copied: (() => void) | undefined;
  let read: (() => void) | undefined;
  let fail: (() => void) | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    fail = () => reject(new Error('storage migration failed'));
  });
  const timeout = setTimeout(() => fail?.(), 30_000);
  const watchHelper = (window: BrowserWindow) => {
    window.webContents.on('render-process-gone', () => fail?.());
    window.on('closed', () => fail?.());
  };
  const destroyHelper = () => {
    if (!helper || helper.isDestroyed()) return;
    helper.removeAllListeners('closed');
    helper.webContents.removeAllListeners('render-process-gone');
    helper.destroy();
  };
  try {
    helper = createHelper(true);
    watchHelper(helper);
    ipcMain.handle(STORAGE_MIGRATION_CHANNEL, (event, raw: unknown) => {
      const expected = phase === 'read' ? LEGACY_STORAGE_MIGRATION_URL : STORAGE_MIGRATION_URL;
      if (
        !helper ||
        helper.isDestroyed() ||
        event.sender !== helper.webContents ||
        event.senderFrame !== helper.webContents.mainFrame ||
        event.senderFrame.url !== expected
      )
        throw new Error('unauthorized');
      const parsed = MigrationMessageSchema.safeParse(raw);
      if (!parsed.success) throw new Error('invalid migration message');
      const message = parsed.data;
      if (message.step === 'failed') {
        fail?.();
        return undefined;
      }
      if (phase === 'read' && message.step === 'read') {
        entries = message.entries;
        read?.();
        return undefined;
      }
      if (phase === 'write' && message.step === 'write') return entries;
      if (phase === 'write' && message.step === 'complete') {
        phase = 'complete';
        copied?.();
        return undefined;
      }
      throw new Error('invalid migration phase');
    });
    const sourceReady = new Promise<void>((resolve) => {
      read = resolve;
    });
    allowHelper(helper);
    await Promise.race([
      Promise.all([helper.loadURL(LEGACY_STORAGE_MIGRATION_URL), sourceReady]),
      failure,
    ]);
    allowHelper(null);
    destroyHelper();
    helper = createHelper(false);
    watchHelper(helper);
    phase = 'write';
    const destinationReady = new Promise<void>((resolve) => {
      copied = resolve;
    });
    await Promise.race([
      Promise.all([helper.loadURL(STORAGE_MIGRATION_URL), destinationReady]),
      failure,
    ]);
    session.defaultSession.flushStorageData();
  } finally {
    clearTimeout(timeout);
    allowHelper(null);
    ipcMain.removeHandler(STORAGE_MIGRATION_CHANNEL);
    destroyHelper();
  }
  await updateSettings({ walletOriginMigrationV1: true });
  logMain('[storage] wallet origin migration complete');
}
