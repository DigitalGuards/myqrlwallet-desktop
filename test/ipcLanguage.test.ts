import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '../src/shared/constants';
import { readSettingsFile } from '../src/main/settingsFile';
import { LANGUAGES } from '../src/shared/language';
import { NullVault } from '../src/keyvault/nullVault';

register(new URL('./ipcLanguageMockLoader.mjs', import.meta.url));
const { app, BrowserWindow, ipcMain } = await import('electron');
const { registerIpcHandlers } = await import('../src/main/ipc');
const { SignerBridge } = await import('../src/main/signerBridge');
const { getLanguage, applyLanguage } = await import('../src/main/language');

test('registered setLanguage handler checks the real sender gate and strict schema before persistence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qrl-i18n-ipc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => applyLanguage('en'));
  t.mock.method(app, 'getPath', () => dir);
  const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
  t.mock.method(
    ipcMain,
    'handle',
    (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
      handlers.set(channel, handler);
    },
  );
  Object.defineProperty(globalThis, '__dirname', { value: '.', configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__dirname');
  });
  const win = new BrowserWindow();
  const noAction = () => {
    assert.fail('language selection reached a wallet operation');
  };
  registerIpcHandlers({
    getWindow: () => win,
    signer: new SignerBridge(noAction),
    keyVault: new NullVault(),
    showUnlock: noAction,
    notifyUnlocked: noAction,
    showSettings: noAction,
  });
  const handler = handlers.get(IPC.SET_LANGUAGE);
  assert.ok(handler);
  const event: IpcMainInvokeEvent = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
    frameId: 1,
    processId: 1,
    type: 'frame',
    defaultPrevented: false,
    preventDefault: () => undefined,
  };
  for (const language of LANGUAGES) {
    await handler(event, language);
    assert.equal(getLanguage(), language);
    assert.equal((await readSettingsFile(path.join(dir, 'settings.json'))).language, language);
  }
  for (const raw of [
    undefined,
    null,
    5,
    '',
    'fr',
    'de-DE',
    ['de'],
    { language: 'de' },
    { language: 'de', label: 'Approve' },
    'en'.repeat(10000),
  ]) {
    await assert.rejects(async () => {
      await handler(event, raw);
    }, /invalid request/);
    assert.equal(getLanguage(), 'zh-CN');
    assert.equal((await readSettingsFile(path.join(dir, 'settings.json'))).language, 'zh-CN');
  }
  const other = new BrowserWindow();
  for (const senderFrame of [null, other.webContents.mainFrame]) {
    await assert.rejects(async () => {
      await handler({ ...event, senderFrame }, 'de');
    }, /unauthorized sender/);
  }
  Object.defineProperty(win.webContents.mainFrame, 'url', { value: 'https://dapp.example/' });
  await assert.rejects(async () => {
    await handler(event, 'de');
  }, /unauthorized sender/);
  t.mock.method(win, 'isDestroyed', () => true);
  await assert.rejects(async () => {
    await handler(event, 'de');
  }, /unauthorized sender/);
  assert.equal((await readSettingsFile(path.join(dir, 'settings.json'))).language, 'zh-CN');
});
