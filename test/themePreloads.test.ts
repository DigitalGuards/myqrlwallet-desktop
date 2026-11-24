/**
 * The theme in the three preloads. The unlock and settings preloads only style
 * their page: they read the resolved theme from the creation-time argument,
 * main's pull and main's push, accept `dark` or `light` and nothing else, set
 * data-theme on <html> as soon as it exists, expose nothing new, and leave the
 * bridge mounted when anything fails. The wallet preload exposes main's
 * `{ theme, resolved }` as a frozen value read before the page runs, plus
 * setTheme and an onThemeChanged wrapper that strips the event.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { EVENTS, IPC, SYNC } from '../src/shared/constants';
import { isRecord } from '../src/shared/guards';
import { networkBuildDefines } from '../src/main/config';

register(new URL('./themePreloadMockLoader.mjs', import.meta.url));
const electron = await import('electron');

class FakeElement {
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeObserver {
  static live = new Set<FakeObserver>();
  constructor(readonly callback: () => void) {}
  observe(): void {
    FakeObserver.live.add(this);
  }
  disconnect(): void {
    FakeObserver.live.delete(this);
  }
}

interface Harness {
  root: () => FakeElement | null;
  /** The parser inserts <html>: observers run as they would before any script. */
  addRoot: () => FakeElement;
  exposed: () => Record<string, unknown>;
  push: (raw: unknown) => void;
  invoked: string[];
  /** ipcRenderer.on registrations and synchronous reads, in call order. */
  order: string[];
  resolvePull: (value: unknown) => Promise<void>;
  rejectPull: () => Promise<void>;
}

let imports = 0;

/** Import a fresh copy of `module` with a fake DOM, argv and ipcRenderer. */
async function load(
  t: TestContext,
  module: string,
  options: {
    argv?: string;
    rootFirst?: boolean;
    onThrows?: boolean;
    sendSync?: (...args: unknown[]) => unknown;
  } = {},
): Promise<Harness> {
  let root: FakeElement | null = options.rootFirst ? new FakeElement() : null;
  const document = {
    get documentElement(): FakeElement | null {
      return root;
    },
    querySelector(selector: string): FakeElement | null {
      return selector === 'html' ? root : null;
    },
  };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'MutationObserver', {
    value: FakeObserver,
    configurable: true,
  });
  FakeObserver.live.clear();
  const argv = process.argv.slice();
  if (options.argv !== undefined) process.argv.push(options.argv);
  t.after(() => {
    process.argv.splice(0, process.argv.length, ...argv);
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'MutationObserver');
  });
  let exposed: unknown;
  t.mock.method(electron.contextBridge, 'exposeInMainWorld', (_key: string, value: unknown) => {
    exposed = value;
  });
  const listeners = new Map<string, (event: unknown, raw: unknown) => void>();
  const order: string[] = [];
  t.mock.method(
    electron.ipcRenderer,
    'on',
    (channel: string, listener: (event: unknown, raw: unknown) => void) => {
      if (options.onThrows) throw new Error('ipc unavailable');
      order.push(`on ${channel}`);
      listeners.set(channel, listener);
      return electron.ipcRenderer;
    },
  );
  const invoked: string[] = [];
  let settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  t.mock.method(electron.ipcRenderer, 'invoke', (channel: string) => {
    invoked.push(channel);
    return new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
  });
  const { sendSync } = options;
  if (sendSync) {
    t.mock.method(electron.ipcRenderer, 'sendSync', (...args: unknown[]) => {
      order.push('sendSync');
      return Reflect.apply(sendSync, undefined, args);
    });
  }
  imports += 1;
  await import(`${module}?case=${String(imports)}`);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    root: () => root,
    addRoot: () => {
      root = new FakeElement();
      for (const observer of [...FakeObserver.live]) observer.callback();
      return root;
    },
    exposed: () => {
      assert.ok(isRecord(exposed), 'the bridge is mounted');
      return exposed;
    },
    push: (raw) => {
      const listener = listeners.get(EVENTS.THEME_CHANGED);
      assert.ok(listener, 'subscribed to theme pushes');
      listener({ sender: 'event object' }, raw);
    },
    invoked,
    order,
    resolvePull: async (value) => {
      settle?.resolve(value);
      await flush();
    },
    rejectPull: async () => {
      settle?.reject(new Error('unauthorized'));
      await flush();
    },
  };
}

const NATIVE = [
  {
    name: 'unlock',
    module: '../src/unlock/preload.ts',
    pull: 'unlock:getTheme',
    keys: ['biometric', 'getInfo', 'getLanguage', 'onLanguageChanged', 'submit'],
  },
  {
    name: 'settings',
    module: '../src/settings/preload.ts',
    pull: 'settings:getTheme',
    keys: ['action', 'close', 'get', 'getLanguage', 'onLanguageChanged', 'removeWallet', 'set'],
  },
] as const;

for (const surface of NATIVE) {
  test(`${surface.name} preload: the first frame takes the creation-time theme as soon as <html> exists`, async (t) => {
    const page = await load(t, surface.module, { argv: '--qrl-theme=light' });
    assert.equal(page.root(), null, 'the preload runs before <html> exists');
    const root = page.addRoot();
    assert.equal(root.getAttribute('data-theme'), 'light');
    assert.equal(FakeObserver.live.size, 0, 'the observer stops once it painted');
    assert.deepEqual(
      Object.keys(page.exposed()).sort(),
      [...surface.keys].sort(),
      'nothing new is exposed',
    );
    assert.deepEqual(page.invoked, [surface.pull]);
    // Main's pull and push apply dark or light and ignore everything else.
    await page.resolvePull({ theme: 'system', resolved: 'dark' });
    assert.equal(root.getAttribute('data-theme'), null);
    for (const raw of [
      { resolved: 'purple' },
      { resolved: 'Light' },
      'light',
      null,
      7,
      ['light'],
      { theme: 'light' },
    ]) {
      page.push(raw);
      assert.equal(root.getAttribute('data-theme'), null, JSON.stringify(raw));
    }
    page.push({ theme: 'light', resolved: 'light' });
    assert.equal(root.getAttribute('data-theme'), 'light');
    page.push({ theme: 'dark', resolved: 'dark' });
    assert.equal(root.getAttribute('data-theme'), null);
  });

  test(`${surface.name} preload: an invalid argument is ignored and a failed pull changes nothing`, async (t) => {
    const page = await load(t, surface.module, { argv: '--qrl-theme=blue', rootFirst: true });
    const root = page.root();
    assert.ok(root);
    assert.equal(root.getAttribute('data-theme'), null);
    await page.rejectPull();
    assert.equal(root.getAttribute('data-theme'), null);
    page.push({ theme: 'light', resolved: 'light' });
    assert.equal(root.getAttribute('data-theme'), 'light');
  });

  test(`${surface.name} preload: with no argument the pull decides, and a failure leaves the bridge mounted`, async (t) => {
    const page = await load(t, surface.module, { rootFirst: true });
    await page.resolvePull({ theme: 'light', resolved: 'light' });
    assert.equal(page.root()?.getAttribute('data-theme'), 'light');
    const broken = await load(t, surface.module, {
      argv: '--qrl-theme=light',
      rootFirst: true,
      onThrows: true,
    });
    assert.deepEqual(Object.keys(broken.exposed()).sort(), [...surface.keys].sort());
  });
}

async function loadWallet(t: TestContext, sendSync: () => unknown) {
  const network: unknown = JSON.parse(networkBuildDefines(undefined).__QRL_WALLET_NETWORK__);
  Object.defineProperty(globalThis, '__QRL_WALLET_NETWORK__', {
    value: network,
    configurable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__QRL_WALLET_NETWORK__');
  });
  const calls: unknown[][] = [];
  const page = await load(t, '../src/preload/index.ts', {
    rootFirst: true,
    sendSync: (...args: unknown[]) => {
      calls.push(args);
      return sendSync();
    },
  });
  return { page, calls };
}

const WALLET_MEMBERS = [
  'addressScheme',
  'buildTransaction',
  'createWallet',
  'dappRequestAttention',
  'features',
  'getBalance',
  'getStatus',
  'hasWallet',
  'importWallet',
  'listWallets',
  'lock',
  'network',
  'onDAppConnectUri',
  'onLockStateChanged',
  'onThemeChanged',
  'openDesktopSettings',
  'removeWallet',
  'requestSignature',
  'sendRawTransaction',
  'setActiveWallet',
  'setLanguage',
  'setTheme',
  'unlock',
];

test('wallet preload: main theme read once at start, exposed as a frozen value', async (t) => {
  const { page, calls } = await loadWallet(t, () => ({
    theme: 'system',
    resolved: 'light',
    extra: 'x',
  }));
  assert.deepEqual(calls, [[SYNC.GET_THEME]], 'one synchronous read, on the theme channel only');
  const api = page.exposed();
  assert.deepEqual(Object.keys(api).sort(), [...WALLET_MEMBERS, 'theme'].sort());
  assert.deepEqual(api['theme'], { theme: 'system', resolved: 'light' });
  assert.ok(Object.isFrozen(api['theme']));
  // setTheme invokes its channel with the value; main validates it.
  const setTheme = api['setTheme'];
  assert.equal(typeof setTheme, 'function');
  if (typeof setTheme !== 'function') return;
  void Reflect.apply(setTheme, api, ['light']);
  assert.equal(page.invoked.at(-1), IPC.SET_THEME);
});

/** Subscribe through the exposed onThemeChanged; returns what it hears and the unsubscribe. */
function subscribe(api: Record<string, unknown>): { seen: unknown[][]; off: () => void } {
  const on = api['onThemeChanged'];
  if (typeof on !== 'function') assert.fail('onThemeChanged is exposed');
  const seen: unknown[][] = [];
  const off: unknown = Reflect.apply(on, api, [(...args: unknown[]) => seen.push(args)]);
  if (typeof off !== 'function') assert.fail('onThemeChanged returns an unsubscribe');
  return {
    seen,
    off: () => {
      Reflect.apply(off, undefined, []);
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('wallet preload: onThemeChanged hands over a validated pair only, and unsubscribes', async (t) => {
  const { page } = await loadWallet(t, () => ({ theme: 'dark', resolved: 'dark' }));
  // One preload listener, registered before the synchronous read.
  assert.deepEqual(page.order, [`on ${EVENTS.THEME_CHANGED}`, 'sendSync']);
  const api = page.exposed();
  const removed: string[] = [];
  t.mock.method(electron.ipcRenderer, 'removeListener', (channel: string) => {
    removed.push(channel);
    return electron.ipcRenderer;
  });
  const { seen, off } = subscribe(api);
  await settle();
  assert.deepEqual(seen, [], 'nothing moved since the start value');
  page.push({ theme: 'light', resolved: 'light', label: 'Approve' });
  for (const raw of [
    null,
    'light',
    { theme: 'blue', resolved: 'light' },
    { theme: 'light', resolved: 'system' },
    { theme: 'light' },
  ]) {
    page.push(raw);
  }
  await settle();
  assert.deepEqual(
    seen,
    [[{ theme: 'light', resolved: 'light' }]],
    'one call, one argument, no event object',
  );
  off();
  page.push({ theme: 'system', resolved: 'dark' });
  await settle();
  assert.equal(seen.length, 1, 'a push after the unsubscribe reaches nobody');
  // Subscribing again never adds an IPC listener.
  subscribe(api).off();
  assert.deepEqual(page.order, [`on ${EVENTS.THEME_CHANGED}`, 'sendSync']);
  assert.deepEqual(removed, [], 'the preload listener stays for the document');
});

test('wallet preload: a push before the renderer subscribes reaches each new subscriber once', async (t) => {
  const { page } = await loadWallet(t, () => ({ theme: 'system', resolved: 'dark' }));
  const api = page.exposed();
  assert.deepEqual(api['theme'], { theme: 'system', resolved: 'dark' });
  // The OS flips while the page loads, before the renderer subscribes. Invalid
  // pushes in between change nothing.
  page.push({ theme: 'system', resolved: 'light' });
  page.push({ theme: 'system', resolved: 'purple' });
  page.push(null);
  const first = subscribe(api);
  assert.deepEqual(first.seen, [], 'handed over after the caller has its unsubscribe');
  await settle();
  assert.deepEqual(first.seen, [[{ theme: 'system', resolved: 'light' }]]);
  // A later subscriber gets the same latest state once, and live pushes follow.
  const second = subscribe(api);
  await settle();
  assert.deepEqual(second.seen, [[{ theme: 'system', resolved: 'light' }]]);
  page.push({ theme: 'light', resolved: 'light' });
  await settle();
  for (const subscriber of [first, second]) {
    assert.deepEqual(subscriber.seen, [
      [{ theme: 'system', resolved: 'light' }],
      [{ theme: 'light', resolved: 'light' }],
    ]);
  }
  // A subscriber that unsubscribes at once hears nothing.
  const gone = subscribe(api);
  gone.off();
  await settle();
  assert.deepEqual(gone.seen, []);
  // A live push that reaches a new subscriber first is not repeated.
  const racing = subscribe(api);
  page.push({ theme: 'dark', resolved: 'dark' });
  await settle();
  assert.deepEqual(racing.seen, [[{ theme: 'dark', resolved: 'dark' }]]);
});

test('wallet preload: no hand-over when the latest push equals the start value', async (t) => {
  const { page } = await loadWallet(t, () => ({ theme: 'light', resolved: 'light' }));
  page.push({ theme: 'dark', resolved: 'dark' });
  page.push({ theme: 'light', resolved: 'light' });
  const { seen } = subscribe(page.exposed());
  await settle();
  assert.deepEqual(seen, []);
});

test('wallet preload: without a start value the first valid push is handed over', async (t) => {
  const { page } = await loadWallet(t, () => {
    throw new Error('no listener');
  });
  const api = page.exposed();
  assert.equal(api['theme'], undefined);
  page.push({ theme: 'light', resolved: 'light' });
  const { seen } = subscribe(api);
  await settle();
  assert.deepEqual(seen, [[{ theme: 'light', resolved: 'light' }]]);
});

test('wallet preload: an invalid or failed read leaves theme out and the bridge mounted', async (t) => {
  for (const sendSync of [
    () => null,
    () => undefined,
    () => 'light',
    () => ({ theme: 'blue', resolved: 'light' }),
    () => ({ theme: 'light', resolved: 'system' }),
    () => ({ theme: 'light' }),
    () => {
      throw new Error('no listener');
    },
  ]) {
    const { page } = await loadWallet(t, sendSync);
    assert.deepEqual(Object.keys(page.exposed()).sort(), [...WALLET_MEMBERS].sort());
  }
});
