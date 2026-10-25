import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { EncryptedSeed } from '../src/shared/protocol';
import { IPC, KDF_DEFAULTS, SEED_FILE_VERSION } from '../src/shared/constants';
import { isRecord } from '../src/shared/guards';
import { readSettingsFile, updateSettingsFile } from '../src/main/settingsFile';
import { NullVault } from '../src/keyvault/nullVault';
import { malformed } from './helpers/malformed';
import { EXPECTED_CHAIN_ID, EXPECTED_GENESIS_HASH } from '../src/main/config';

register(new URL('./unlockPhraseMockLoader.mjs', import.meta.url));
const electron = await import('electron');
const { registerIpcHandlers } = await import('../src/main/ipc');
const { registerSettingsIpc, showSettingsView, closeSettingsView } =
  await import('../src/main/settingsView');
const { registerUnlockIpc, showUnlockWindow, setOnUnlockShown } =
  await import('../src/main/unlockWindow');
const { SignerBridge } = await import('../src/main/signerBridge');
const { writeSeed, setActiveAddress } = await import('../src/main/seedFile');

function eventFor(sender: WebContents): IpcMainInvokeEvent {
  return malformed<IpcMainInvokeEvent>({ sender, senderFrame: sender.mainFrame });
}

function envelope(letter: string): EncryptedSeed {
  return {
    version: SEED_FILE_VERSION,
    address: `Q${letter.repeat(128)}`,
    kdf: KDF_DEFAULTS,
    salt: '00'.repeat(16),
    seed: { iv: '00'.repeat(12), tag: '00'.repeat(16), ciphertext: '01' },
    mnemonic: { iv: '00'.repeat(12), tag: '00'.repeat(16), ciphertext: '02' },
  };
}

// Every production handler is registered, every wallet method executes its real
// handler successfully, and the response is checked for a persisted canary.
// Extending either surface requires an explicit fixture here.
test('personal phrase stays outside every wallet preload method, IPC reply and event', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'phrase-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  Object.defineProperty(globalThis, '__dirname', { value: '.', configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__dirname');
  });
  t.mock.method(electron.app, 'getPath', () => directory);
  const file = path.join(directory, 'settings.json');
  const canary = 'PRIVATE Personal Mark 9f73';
  await updateSettingsFile(file, { unlockPhrase: canary, autolockMs: 900_000 });
  const marks = [canary];
  const assertPrivate = (value: unknown) => {
    const serialized = JSON.stringify({ value });
    for (const mark of marks) assert.ok(!serialized.includes(mark), 'native phrase leaked');
    assert.ok(!serialized.includes('unlockPhrase'), 'native settings field leaked');
  };
  const handlers = new Map<string, Parameters<typeof electron.ipcMain.handle>[1]>();
  t.mock.method(
    electron.ipcMain,
    'handle',
    (channel: string, handler: Parameters<typeof electron.ipcMain.handle>[1]) => {
      handlers.set(channel, handler);
    },
  );
  const win = new electron.BrowserWindow();
  t.mock.method(win.webContents, 'send', (_channel: string, ...args: unknown[]) => {
    assertPrivate(args);
  });
  const signer = new SignerBridge(() => undefined);
  let unlocked = true;
  let active = envelope('a').address;
  t.mock.method(signer, 'status', () =>
    Promise.resolve({ unlocked, address: active, unlockExpiresAt: null }),
  );
  const unlockMock = t.mock.method(
    signer,
    'unlock',
    (request: Parameters<typeof signer.unlock>[0]) => {
      if (request.password === 'wrong') return Promise.reject(new Error('wrong password'));
      unlocked = true;
      active = request.encrypted.address;
      return Promise.resolve({ address: active, unlockExpiresAt: 123 });
    },
  );
  t.mock.method(signer, 'lock', () => {
    unlocked = false;
    return Promise.resolve();
  });
  const rearm = t.mock.method(signer, 'setAutolock', () => Promise.resolve());
  t.mock.method(signer, 'create', () =>
    Promise.resolve({
      address: envelope('b').address,
      encrypted: envelope('b'),
      mnemonic: 'public recovery fixture',
    }),
  );
  t.mock.method(signer, 'importWallet', () =>
    Promise.resolve({ address: envelope('c').address, encrypted: envelope('c') }),
  );
  t.mock.method(signer, 'sign', () =>
    Promise.resolve({
      kind: 'transaction',
      signature: '0x02',
      rawTransaction: '0x02',
      signer: active,
    }),
  );
  const keyVault = new NullVault();
  t.mock.method(keyVault, 'isAvailable', () => Promise.resolve(true));
  t.mock.method(keyVault, 'has', () => Promise.resolve(true));
  t.mock.method(keyVault, 'retrieve', () => Promise.resolve('00'.repeat(32)));
  const deletion = t.mock.method(keyVault, 'delete', () => Promise.resolve());
  const deps = {
    getMainWindow: () => win,
    signer,
    keyVault,
    reregisterProtocol: () => true,
    showUnlock: () => undefined,
  };
  registerIpcHandlers({
    getWindow: () => win,
    signer,
    keyVault,
    showUnlock: () => undefined,
    notifyUnlocked: () => undefined,
    showSettings: () => showSettingsView(deps),
  });
  registerSettingsIpc(deps);
  registerUnlockIpc(deps);
  setOnUnlockShown(closeSettingsView);
  const walletEvent = eventFor(win.webContents);
  const invoke = async (
    channel: string,
    event: IpcMainInvokeEvent,
    raw?: unknown,
  ): Promise<unknown> => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    const result: unknown = await handler(event, raw);
    return result;
  };
  // Track the preload's actual calls and subscriptions, including any future method.
  let api: unknown;
  const invoked = new Set<string>();
  t.mock.method(electron.contextBridge, 'exposeInMainWorld', (key: string, value: unknown) => {
    assert.equal(key, 'qrlWallet');
    api = value;
  });
  t.mock.method(electron.ipcRenderer, 'invoke', async (channel: string, ...args: unknown[]) => {
    invoked.add(channel);
    return invoke(channel, walletEvent, args[0]);
  });
  const subscribed = new Set<string>();
  t.mock.method(electron.ipcRenderer, 'on', (channel: string) => {
    subscribed.add(channel);
    return electron.ipcRenderer;
  });
  await import('../src/preload/index');
  assert.ok(isRecord(api));
  await writeSeed(envelope('a'));
  await setActiveAddress(envelope('a').address);
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: { body?: unknown }) => {
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(isRecord(body));
    const result =
      body['method'] === 'qrl_chainId'
        ? `0x${EXPECTED_CHAIN_ID.toString(16)}`
        : body['method'] === 'qrl_getBlockByNumber'
          ? { hash: EXPECTED_GENESIS_HASH, gasLimit: '0x1c9c380', baseFeePerGas: '0x1' }
          : body['method'] === 'qrl_sendRawTransaction'
            ? '0x' + 'ab'.repeat(32)
            : '0x5208';
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: body['id'], result }));
  });
  const tx = {
    from: active,
    to: active,
    value: '1',
    nonce: 0,
    gas: '21000',
    maxFeePerGas: '2',
    maxPriorityFeePerGas: '1',
    chainId: EXPECTED_CHAIN_ID,
    type: '0x2',
  };
  const calls: Record<string, unknown[]> = {
    setLanguage: ['de'],
    getBalance: [{ address: active }],
    buildTransaction: [{ from: active, to: active, value: '1' }],
    requestSignature: [{ kind: 'transaction', tx }],
    unlock: [{ password: 'correct' }],
    getStatus: [],
    hasWallet: [],
    listWallets: [],
    setActiveWallet: [{ address: active }],
    createWallet: [{ password: 'correct' }],
    importWallet: [{ password: 'correct', hexSeed: '010000' + '01'.repeat(48) }],
    sendRawTransaction: [{ rawTx: '0x02' }],
    dappRequestAttention: [],
    openDesktopSettings: [],
    onLockStateChanged: [assertPrivate],
    onDAppConnectUri: [assertPrivate],
    lock: [],
    removeWallet: [{ address: envelope('c').address }],
  };
  assert.deepEqual(
    Object.keys(api).sort(),
    [...Object.keys(calls), 'features', 'addressScheme'].sort(),
  );
  for (const [name, args] of Object.entries(calls)) {
    const method: unknown = api[name];
    assert.equal(typeof method, 'function', name);
    if (typeof method !== 'function') throw new Error('missing wallet method');
    const result: unknown = await Reflect.apply(method, api, args);
    assertPrivate(result);
  }
  assert.deepEqual(
    [...invoked].sort(),
    Object.values(IPC).sort(),
    'every wallet handler exercised',
  );
  assert.deepEqual([...subscribed].sort(), ['wallet:dappConnectUri', 'wallet:lockStateChanged']);
  assertPrivate(api['features']);
  assertPrivate(api['addressScheme']);
  assert.equal((await readSettingsFile(file)).unlockPhrase, canary);

  // The inventory includes ALL handlers under src/main. A new registration
  // location requires extending this test before the isolation gate passes.
  const reviewed = ['ipc.ts', 'settingsView.ts', 'unlockWindow.ts', 'storageMigration.ts'];
  for (const name of await readdir(new URL('../src/main/', import.meta.url))) {
    if (!name.endsWith('.ts') || reviewed.includes(name)) continue;
    assert.doesNotMatch(
      await readFile(new URL(`../src/main/${name}`, import.meta.url), 'utf8'),
      /ipcMain\s*\.\s*(?:handle|on)\s*\(/u,
    );
  }
  // The startup storage move registers one channel for its own helper windows,
  // removes it before the wallet opens, and never touches the phrase.
  const migration = await readFile(
    new URL('../src/main/storageMigration.ts', import.meta.url),
    'utf8',
  );
  assert.equal(migration.match(/ipcMain\s*\.\s*(?:handle|on)\s*\(/gu)?.length, 1);
  assert.match(migration, /ipcMain\.handle\(STORAGE_MIGRATION_CHANNEL,/u);
  assert.match(migration, /event\.sender !== helper\.webContents/u);
  assert.match(migration, /ipcMain\.removeHandler\(STORAGE_MIGRATION_CHANNEL\)/u);
  assert.doesNotMatch(migration, /unlockPhrase/u);
  const nativeChannels = [...handlers.keys()].filter((channel) => !invoked.has(channel));
  assert.deepEqual(
    nativeChannels.sort(),
    [
      'settings:action',
      'settings:close',
      'settings:get',
      'settings:getLanguage',
      'settings:randomizeUnlockPhrase',
      'settings:removeWallet',
      'settings:set',
      'unlock:biometric',
      'unlock:getInfo',
      'unlock:getLanguage',
      'unlock:submit',
    ].sort(),
  );
  showSettingsView(deps);
  const settings = electron.webContents
    .getAllWebContents()
    .find((contents) => !contents.isDestroyed() && contents.getURL().includes('/settings/'));
  assert.ok(settings);
  const settingsEvent = eventFor(settings);
  const settingsInfo = await invoke('settings:get', settingsEvent);
  assert.ok(isRecord(settingsInfo) && isRecord(settingsInfo['settings']));
  assert.equal(settingsInfo['settings']['unlockPhrase'], canary);
  for (const raw of [
    { unlockPhrase: '<script>' },
    { unlockPhrase: '𐐀'.repeat(33) },
    { unlockPhrase: 'new phrase', extra: true },
  ]) {
    await assert.rejects(invoke('settings:set', settingsEvent, raw), /invalid settings payload/);
    assert.equal((await readSettingsFile(file)).unlockPhrase, canary);
  }
  await invoke('settings:set', settingsEvent, {
    unlockPhrase: 'Meine blaue Wiese',
    autolockMs: 60_000,
    biometricUnlock: false,
  });
  marks.push('Meine blaue Wiese');
  assert.equal(rearm.mock.callCount(), 1);
  assert.ok(deletion.mock.callCount() >= 2);
  const rotated = await invoke('settings:randomizeUnlockPhrase', settingsEvent);
  assert.equal(typeof rotated, 'string');
  if (typeof rotated !== 'string') throw new Error('missing rotated mark');
  marks.push(rotated);
  assert.notEqual(rotated, 'Meine blaue Wiese');
  await invoke('settings:set', settingsEvent, { biometricUnlock: true });
  showUnlockWindow(deps);
  const unlockWindow = electron.BrowserWindow.getAllWindows().find((window) => window !== win);
  assert.ok(unlockWindow);
  const unlockEvent = eventFor(unlockWindow.webContents);
  const info = await invoke('unlock:getInfo', unlockEvent);
  assert.ok(isRecord(info));
  assert.equal(info['unlockPhrase'], rotated);
  for (const channel of nativeChannels) {
    for (const event of [
      walletEvent,
      { ...walletEvent, senderFrame: unlockEvent.senderFrame },
      { ...unlockEvent, senderFrame: null },
      settingsEvent,
    ]) {
      await assert.rejects(
        invoke(channel, event, { unlockPhrase: 'stolen mark', password: 'correct' }),
        /unauthorized/,
      );
    }
  }
  assert.deepEqual(await invoke('unlock:submit', unlockEvent, { password: 'wrong' }), {
    ok: false,
    errorKey: 'unlock.incorrect',
  });
  assert.equal(win.isVisible(), false);
  assert.deepEqual(
    await invoke('unlock:submit', unlockEvent, {
      password: 'correct',
      address: envelope('a').address,
    }),
    { ok: true },
  );
  assert.equal(win.isVisible(), true);
  assert.equal(unlockMock.mock.calls.at(-1)?.arguments[0].autolockMs, 60_000);
  showUnlockWindow(deps);
  const biometricWindow = electron.BrowserWindow.getAllWindows().find((window) => window !== win);
  assert.ok(biometricWindow);
  assert.deepEqual(await invoke('unlock:biometric', eventFor(biometricWindow.webContents), {}), {
    ok: true,
  });
  showUnlockWindow(deps);
  const closing = electron.BrowserWindow.getAllWindows().find((window) => window !== win);
  assert.ok(closing);
  const quit = t.mock.method(electron.app, 'quit', () => undefined);
  closing.close();
  assert.equal(quit.mock.callCount(), 1, 'closing a locked window exits');
  const log = await readFile(path.join(directory, 'logs/main.log'), 'utf8');
  assertPrivate(log);
});
