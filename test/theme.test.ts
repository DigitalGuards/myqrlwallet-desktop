/**
 * The colour theme main owns: the default, the stored choice, invalid stored
 * values, writes only on a choice, listeners, nativeTheme.themeSource and the
 * OS following of `system`; then the wallet window's setTheme handler (sender
 * gate + strict three-value schema) and its synchronous start read.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { register } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { IPC, SYNC } from '../src/shared/constants';
import {
  THEMES,
  THEME_BACKGROUND,
  type ThemePreference,
  type ThemeState,
} from '../src/shared/theme';
import { readSettingsFile, updateSettingsFile } from '../src/main/settingsFile';
import { NullVault } from '../src/keyvault/nullVault';
import { malformed } from './helpers/malformed';

register(new URL('./ipcLanguageMockLoader.mjs', import.meta.url));
const { app, BrowserWindow, ipcMain } = await import('electron');
const { registerIpcHandlers } = await import('../src/main/ipc');
const { SignerBridge } = await import('../src/main/signerBridge');
const theme = await import('../src/main/theme');

/** nativeTheme as Electron behaves: assigning themeSource fires `updated`,
 * and shouldUseDarkColors follows the source, or the OS for `system`. */
class FakeNativeTheme extends EventEmitter {
  osDark = true;
  #source: ThemePreference = 'system';
  get themeSource(): ThemePreference {
    return this.#source;
  }
  set themeSource(next: ThemePreference) {
    this.#source = next;
    this.emit('updated');
  }
  get shouldUseDarkColors(): boolean {
    return this.#source === 'system' ? this.osDark : this.#source === 'dark';
  }
  flipOs(dark: boolean): void {
    this.osDark = dark;
    this.emit('updated');
  }
}

async function profile(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'qrl-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(app, 'getPath', () => dir);
  return { dir, file: path.join(dir, 'settings.json') };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

test('nothing stored: the default is dark, nativeTheme follows it and nothing is written', async (t) => {
  const { file } = await profile(t);
  assert.equal(theme.DEFAULT_THEME, 'dark');
  const native = new FakeNativeTheme();
  const stored = await readSettingsFile(file);
  assert.equal(stored.theme, undefined);
  theme.initTheme(native, stored.theme);
  assert.deepEqual(theme.getThemeState(), { theme: 'dark', resolved: 'dark' });
  assert.equal(native.themeSource, 'dark');
  assert.equal(theme.themeBackground(), THEME_BACKGROUND.dark);
  assert.equal(theme.themeArgument(), '--qrl-theme=dark');
  assert.equal(await exists(file), false, 'reading and applying the default writes nothing');
  // Another preference write never adds the default theme to the file.
  await updateSettingsFile(file, { language: 'de' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { v: 1, language: 'de' });
});

test('a stored choice is adopted at start', async (t) => {
  await profile(t);
  const native = new FakeNativeTheme();
  theme.initTheme(native, 'light');
  assert.deepEqual(theme.getThemeState(), { theme: 'light', resolved: 'light' });
  assert.equal(native.themeSource, 'light');
  assert.equal(theme.themeBackground(), '#f3f4f7');
  assert.equal(theme.themeArgument(), '--qrl-theme=light');
});

test('an invalid stored theme means the default and keeps every other preference', async (t) => {
  const { file } = await profile(t);
  for (const bad of [
    'blue',
    'Light',
    '',
    7,
    null,
    { theme: 'light' },
    ['light'],
    'light '.repeat(50),
  ]) {
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        language: 'de',
        autolockMs: 120_000,
        theme: bad,
        walletOriginMigrationV1: true,
      }),
    );
    const stored = await readSettingsFile(file);
    assert.deepEqual(stored, {
      v: 1,
      language: 'de',
      autolockMs: 120_000,
      walletOriginMigrationV1: true,
    });
    const native = new FakeNativeTheme();
    theme.initTheme(native, stored.theme);
    assert.deepEqual(theme.getThemeState(), { theme: 'dark', resolved: 'dark' });
  }
  // Each valid value survives a read.
  for (const value of THEMES) {
    await writeFile(file, JSON.stringify({ v: 1, theme: value }));
    assert.deepEqual(await readSettingsFile(file), { v: 1, theme: value });
  }
  // Unknown keys still invalidate the envelope, as before.
  await writeFile(file, JSON.stringify({ v: 1, theme: 'light', colour: 'red' }));
  assert.deepEqual(await readSettingsFile(file), { v: 1 });
});

test('setTheme stores the choice, applies it and notifies once per change', async (t) => {
  const { file } = await profile(t);
  await updateSettingsFile(file, { language: 'es', autolockMs: 300_000 });
  const native = new FakeNativeTheme();
  theme.initTheme(native, undefined);
  const seen: ThemeState[] = [];
  const off = theme.onThemeChanged((state) => seen.push(state));
  t.after(off);
  await theme.setTheme('light');
  assert.deepEqual(await readSettingsFile(file), {
    v: 1,
    language: 'es',
    autolockMs: 300_000,
    theme: 'light',
  });
  assert.equal(native.themeSource, 'light');
  assert.deepEqual(seen, [{ theme: 'light', resolved: 'light' }]);
  await theme.setTheme('light');
  assert.deepEqual(
    seen,
    [
      { theme: 'light', resolved: 'light' },
      { theme: 'light', resolved: 'light' },
    ],
    'every successful choice is pushed once, also the same choice again',
  );
  // Concurrent choices are written in order: the last one wins on disk and in memory.
  await Promise.all([theme.setTheme('system'), theme.setTheme('dark')]);
  assert.equal((await readSettingsFile(file)).theme, 'dark');
  assert.deepEqual(theme.getThemeState(), { theme: 'dark', resolved: 'dark' });
  off();
  await theme.setTheme('light');
  assert.equal(seen.at(-1)?.theme, 'dark', 'an unsubscribed listener hears nothing');
});

test('system follows the OS appearance live; a fixed choice ignores it', async (t) => {
  await profile(t);
  const native = new FakeNativeTheme();
  native.osDark = true;
  theme.initTheme(native, 'system');
  assert.equal(native.themeSource, 'system');
  assert.deepEqual(theme.getThemeState(), { theme: 'system', resolved: 'dark' });
  const seen: ThemeState[] = [];
  t.after(theme.onThemeChanged((state) => seen.push(state)));
  native.flipOs(false);
  assert.deepEqual(seen, [{ theme: 'system', resolved: 'light' }]);
  native.flipOs(false);
  assert.equal(seen.length, 1, 'an update without a change notifies nobody');
  native.flipOs(true);
  assert.deepEqual(seen.at(-1), { theme: 'system', resolved: 'dark' });
  theme.applyTheme('light');
  const before = seen.length;
  native.flipOs(false);
  native.flipOs(true);
  assert.equal(seen.length, before, 'an OS flip does not move a fixed choice');
  assert.deepEqual(theme.getThemeState(), { theme: 'light', resolved: 'light' });
});

interface Probe {
  sender?: unknown;
  senderFrame?: unknown;
  returnValue?: unknown;
}

function walletHandlers(t: TestContext) {
  const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
  const listeners = new Map<string, (event: IpcMainEvent) => void>();
  t.mock.method(
    ipcMain,
    'handle',
    (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
      handlers.set(channel, handler);
    },
  );
  t.mock.method(ipcMain, 'on', (channel: string, listener: (event: IpcMainEvent) => void) => {
    listeners.set(channel, listener);
    return ipcMain;
  });
  const win = new BrowserWindow();
  const noAction = () => {
    assert.fail('a theme request reached a wallet operation');
  };
  registerIpcHandlers({
    getWindow: () => win,
    signer: new SignerBridge(noAction),
    keyVault: new NullVault(),
    showUnlock: noAction,
    notifyUnlocked: noAction,
    showSettings: noAction,
  });
  return { handlers, listeners, win };
}

test('the setTheme handler checks the real sender gate and the strict schema before storing', async (t) => {
  const { file } = await profile(t);
  Object.defineProperty(globalThis, '__dirname', { value: '.', configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__dirname');
  });
  theme.initTheme(new FakeNativeTheme(), undefined);
  const { handlers, win } = walletHandlers(t);
  const handler = handlers.get(IPC.SET_THEME);
  assert.ok(handler);
  const event = malformed<IpcMainInvokeEvent>({
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  });
  for (const value of THEMES) {
    await handler(event, value);
    assert.equal(theme.getThemeState().theme, value);
    assert.equal((await readSettingsFile(file)).theme, value);
  }
  for (const raw of [
    undefined,
    null,
    1,
    '',
    'blue',
    'Dark',
    'light ',
    ['light'],
    { theme: 'light' },
    'light'.repeat(1000),
  ]) {
    await assert.rejects(async () => {
      await handler(event, raw);
    }, /invalid request/);
    assert.equal((await readSettingsFile(file)).theme, 'system');
  }
  const other = new BrowserWindow();
  for (const forged of [
    { ...event, sender: other.webContents },
    { ...event, senderFrame: null },
    { ...event, senderFrame: other.webContents.mainFrame },
  ]) {
    await assert.rejects(async () => {
      await handler(forged, 'light');
    }, /unauthorized sender/);
  }
  for (const url of [
    'app://unlock/index.html',
    'app://settings/index.html',
    'https://dapp.example/',
  ]) {
    Object.defineProperty(win.webContents.mainFrame, 'url', { value: url, configurable: true });
    await assert.rejects(async () => {
      await handler(event, 'light');
    }, /unauthorized sender/);
  }
  assert.equal((await readSettingsFile(file)).theme, 'system');
});

test('a failed theme write rejects with a fixed message, logs the detail in main and changes nothing', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qrl-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The profile sits under a regular file, so the settings write fails with a
  // file-system error that names the absolute path.
  await writeFile(path.join(dir, 'blocker'), '');
  const profileDir = path.join(dir, 'blocker', 'MyQRLWallet');
  t.mock.method(app, 'getPath', () => profileDir);
  Object.defineProperty(globalThis, '__dirname', { value: '.', configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__dirname');
  });
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const native = new FakeNativeTheme();
  theme.initTheme(native, 'dark');
  const seen: ThemeState[] = [];
  t.after(theme.onThemeChanged((state) => seen.push(state)));
  const { handlers, win } = walletHandlers(t);
  const handler = handlers.get(IPC.SET_THEME);
  assert.ok(handler);
  const event = malformed<IpcMainInvokeEvent>({
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  });
  let message = '';
  await assert.rejects(
    async () => {
      await handler(event, 'light');
    },
    (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return true;
    },
  );
  assert.equal(message, 'theme not saved');
  assert.ok(!message.includes(dir), 'no profile path reaches the renderer');
  const logged = lines.find((line) => line.includes('[theme] choice not saved'));
  assert.ok(logged, 'main logs the failure');
  assert.ok(logged.includes(dir), 'the log keeps the file-system detail');
  assert.deepEqual(theme.getThemeState(), { theme: 'dark', resolved: 'dark' });
  assert.equal(native.themeSource, 'dark');
  assert.deepEqual(seen, [], 'a failed choice pushes nothing');
  // The sender gate and the schema still answer with their own messages.
  await assert.rejects(async () => {
    await handler(event, 'blue');
  }, /invalid request/);
  await assert.rejects(async () => {
    await handler({ ...event, senderFrame: null }, 'light');
  }, /unauthorized sender/);
});

test('the synchronous start read answers every sender, with the state only for the wallet window', async (t) => {
  await profile(t);
  Object.defineProperty(globalThis, '__dirname', { value: '.', configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__dirname');
  });
  theme.initTheme(new FakeNativeTheme(), 'light');
  const { listeners, win } = walletHandlers(t);
  const read = listeners.get(SYNC.GET_THEME);
  assert.ok(read);
  const ask = (event: Probe): unknown => {
    event.returnValue = 'unset';
    read(malformed<IpcMainEvent>(event));
    return event.returnValue;
  };
  assert.deepEqual(ask({ sender: win.webContents, senderFrame: win.webContents.mainFrame }), {
    theme: 'light',
    resolved: 'light',
  });
  const other = new BrowserWindow();
  assert.equal(ask({ sender: other.webContents, senderFrame: other.webContents.mainFrame }), null);
  assert.equal(ask({ sender: win.webContents, senderFrame: null }), null);
  // A gate that throws still answers, so the renderer can never hang on it.
  const throwing: Probe = { senderFrame: win.webContents.mainFrame };
  Object.defineProperty(throwing, 'sender', {
    get(): never {
      throw new Error('torn down');
    },
  });
  assert.equal(ask(throwing), null);
  Object.defineProperty(win.webContents.mainFrame, 'url', {
    value: 'app://unlock/index.html',
    configurable: true,
  });
  assert.equal(ask({ sender: win.webContents, senderFrame: win.webContents.mainFrame }), null);
});

test('main registers the start read before it creates the wallet window', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('.whenReady()');
  assert.ok(start > 0);
  const boot = source.slice(start);
  const registration = boot.indexOf('registerIpcHandlers(');
  const firstWindow = boot.search(/\bcreateWindow\(/u);
  const themeStart = boot.indexOf('initTheme(nativeTheme');
  assert.ok(registration > 0 && firstWindow > 0 && themeStart > 0);
  assert.ok(themeStart < registration && registration < firstWindow);
});
