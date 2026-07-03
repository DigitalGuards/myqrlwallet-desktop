/**
 * IPC handler registration: the renderer's entire reachable surface.
 *
 * Every handler enforces, in order:
 *   1. sender validation (top frame of the wallet window, file: origin), then
 *   2. zod parse of the argument (reject malformed/oversized/extra-keyed), then
 *   3. the action, with key material confined to the signer.
 *
 * REQUEST_SIGNATURE additionally routes through the trusted main-drawn
 * confirmation modal before any signing occurs.
 *
 * MULTI-WALLET MODEL: any number of wallets live on disk (one encrypted
 * envelope per address, each under its own password), but the signer holds at
 * most ONE unlocked session at a time. An `active` pointer selects which
 * wallet the session/unlock flows target; switching to a different account
 * drops the session and raises the native unlock window for the new account.
 */
import { app, type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { confirmRemoveWallet, confirmSignature } from './confirm';
import * as rpc from './rpc';
import { getBiometricUnlockEnabled, getEffectiveAutolockMs } from './settingsFile';
import {
  deleteSeed,
  getActiveAddress,
  hasAnySeed,
  listSeeds,
  readActiveSeed,
  readSeedByAddress,
  setActiveAddress,
  writeSeed,
} from './seedFile';
import { isTrustedSender } from './security';
import { closeSettingsWindow } from './settingsWindow';
import { isUnlockWindowShown } from './unlockWindow';
import { removeWalletFlow } from './walletRemoval';
import type { SignerBridge } from './signerBridge';
import { EVENTS, IPC } from '../shared/constants';
import {
  BuildTransactionRequestSchema,
  CreateWalletRequestSchema,
  GetBalanceRequestSchema,
  ImportWalletRequestSchema,
  RemoveWalletRequestSchema,
  SendRawTransactionRequestSchema,
  SetActiveWalletRequestSchema,
  SignatureRequestSchema,
  UnlockRequestSchema,
  type WalletInfo,
  type WalletListResult,
  type WalletStatus,
} from '../shared/schemas';
import type { KeyVault } from '../keyvault';

interface Deps {
  getWindow: () => BrowserWindow | null;
  signer: SignerBridge;
  keyVault: KeyVault;
  /** Show the native unlock window (called when the renderer requests a lock). */
  showUnlock: () => void;
  /** Tear down a live native unlock window after a renderer-driven unlock, so
   * the two unlock paths cannot desync (window shown while already unlocked). */
  notifyUnlocked: () => void;
  /** Show/focus the native desktop settings window (no data crosses; the
   * window itself refuses to open while locked). */
  showSettings: () => void;
}

// Cache ONLY a successful read: rpc.getChainId throws on an unreachable node,
// so a transient RPC failure can never poison the signing chain id for the
// rest of the process lifetime.
let cachedChainId: number | null = null;
async function chainId(): Promise<number> {
  if (cachedChainId === null) cachedChainId = await rpc.getChainId();
  return cachedChainId;
}

const sameAccount = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function registerIpcHandlers(deps: Deps): void {
  const { getWindow, signer, keyVault, showUnlock, notifyUnlocked, showSettings } = deps;

  /** Wrap a handler with sender validation + (optional) schema parse. */
  function handle<S extends z.ZodTypeAny, R>(
    channel: string,
    schema: S | null,
    fn: (
      arg: S extends z.ZodTypeAny ? z.infer<S> : undefined,
      event: IpcMainInvokeEvent,
    ) => Promise<R>,
  ): void {
    ipcMain.handle(channel, async (event, raw) => {
      if (!isTrustedSender(event, getWindow())) {
        throw new Error('unauthorized sender');
      }
      let arg: unknown;
      if (schema) {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`invalid request: ${parsed.error.issues[0]?.message ?? 'schema'}`);
        }
        arg = parsed.data;
      }
      return fn(arg as never, event);
    });
  }

  /** Return the live wallet window or throw (fail closed). */
  function requireWindow(): BrowserWindow {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('window unavailable');
    return win;
  }

  function emitLockState(locked: boolean): void {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(EVENTS.LOCK_STATE_CHANGED, locked);
  }

  async function walletList(): Promise<WalletListResult> {
    const [seeds, active] = await Promise.all([listSeeds(), getActiveAddress()]);
    // keyVault.has shells out to the OS keychain helper on macOS, so resolve
    // all wallets concurrently rather than one blocking call at a time.
    const wallets: WalletInfo[] = await Promise.all(
      seeds.map(async (s) => ({
        address: s.address,
        keychainBacked: await keyVault.has(s.address),
      })),
    );
    return { wallets, active };
  }

  async function buildStatus(): Promise<WalletStatus> {
    const [{ wallets, active }, st] = await Promise.all([walletList(), signer.status()]);
    const address = st.address ?? active;
    const keychainBacked = address
      ? (wallets.find((w) => sameAccount(w.address, address))?.keychainBacked ?? false)
      : false;
    return {
      hasWallet: wallets.length > 0,
      locked: !st.unlocked,
      address,
      unlockExpiresAt: st.unlockExpiresAt,
      keychainBacked,
      wallets,
      activeAddress: active,
    };
  }

  // ---- read-only ----------------------------------------------------------
  handle(IPC.GET_BALANCE, GetBalanceRequestSchema, async (req) => ({
    address: req.address,
    balance: await rpc.getBalance(req.address),
  }));

  handle(IPC.BUILD_TRANSACTION, BuildTransactionRequestSchema, (req) => rpc.buildTransaction(req));

  // ---- spend path ---------------------------------------------------------
  handle(IPC.REQUEST_SIGNATURE, SignatureRequestSchema, async (req) => {
    // Fast-fail typed-data BEFORE drawing the modal: the signer does not yet
    // implement the byte-exact typed-data hasher, so do not waste a user
    // approval on something that cannot be signed.
    if (req.kind === 'typedData') {
      throw new Error('typed-data signing is not yet supported in the desktop signer');
    }
    // Transactions bind to the chain id: resolve it BEFORE the modal (fail fast
    // when the node is unreachable) and require it to match the tx the user is
    // shown, so the value confirmed in the dialog is exactly the value signed.
    // Message signing is fully offline and must not depend on RPC reachability;
    // the signer ignores the chain id on that arm.
    let signingChainId = 0;
    if (req.kind === 'transaction') {
      signingChainId = await chainId();
      if (req.tx.chainId !== signingChainId) {
        throw new Error('transaction chain id does not match the node; rebuild the transaction');
      }
    }
    // Fail fast when the request targets a different account than the
    // unlocked session, BEFORE drawing the modal: the signer enforces the
    // same binding authoritatively, but the user should not be asked to
    // approve something that cannot be signed. Also guarantees the account
    // shown in the trusted confirm is the account that will sign.
    const requestedSigner = req.kind === 'transaction' ? req.tx.from : req.signer;
    const st = await signer.status();
    if (!st.address || !sameAccount(requestedSigner, st.address)) {
      throw new Error(
        'signing account mismatch: request targets a different account than the unlocked session',
      );
    }
    const approved = await confirmSignature(requireWindow(), req);
    if (!approved) throw new Error('user rejected signature');
    return signer.sign(req, signingChainId);
  });

  // ---- session ------------------------------------------------------------
  handle(IPC.UNLOCK, UnlockRequestSchema, async (req) => {
    const encrypted = req.address ? await readSeedByAddress(req.address) : await readActiveSeed();
    if (!encrypted) throw new Error('no wallet to unlock');
    const autolockMs = await getEffectiveAutolockMs();
    if (req.password) {
      await signer.unlock({ encrypted, autolockMs, password: req.password });
    } else {
      // No password: unlock via a KEK retrieved from the OS keychain.
      const kekHex = await keyVault.retrieve(encrypted.address);
      if (!kekHex) throw new Error('keychain unlock unavailable; password required');
      await signer.unlock({ encrypted, autolockMs, kekHex });
    }
    // Unlocking an account selects it.
    await setActiveAddress(encrypted.address);
    emitLockState(false);
    // Keep the native unlock window coherent with a renderer-driven unlock.
    notifyUnlocked();
    return buildStatus();
  });

  handle(IPC.LOCK, null, async () => {
    await signer.lock();
    emitLockState(true);
    // Renderer-initiated lock (auto-lock timer / logout): surface the native
    // unlock window so the session can be reopened with a password. Only when a
    // wallet actually exists, otherwise locking is a no-op and we must not show a
    // dead-end "No wallet to unlock" screen (e.g. right after a wipe).
    if (await hasAnySeed()) showUnlock();
    return buildStatus();
  });

  // Destructive removal of ONE wallet (the active one when no address is
  // given, mirroring the old single-wallet wipe): delete its encrypted seed
  // from disk and clear its OS-keychain entry. Reachable only behind the
  // renderer's confirmation UI, and gated by the trusted main-drawn
  // confirmation (default Cancel), exactly like the signing path. The flow
  // itself (ordering invariants) is shared with the native settings window:
  // src/main/walletRemoval.ts.
  handle(IPC.REMOVE_WALLET, RemoveWalletRequestSchema, async (req) => {
    await removeWalletFlow(
      {
        signer,
        keyVault,
        seeds: {
          readByAddress: readSeedByAddress,
          getActive: getActiveAddress,
          delete: deleteSeed,
          hasAny: hasAnySeed,
        },
        confirm: (address) => confirmRemoveWallet(requireWindow(), address),
        emitLockState,
        showUnlock,
        warn: (message) => console.error(message),
      },
      req?.address,
    );
    return buildStatus();
  });

  handle(IPC.GET_STATUS, null, () => buildStatus());

  handle(IPC.HAS_WALLET, null, () => hasAnySeed());

  // ---- multi-wallet -------------------------------------------------------
  handle(IPC.LIST_WALLETS, null, () => walletList());

  handle(IPC.SET_ACTIVE_WALLET, SetActiveWalletRequestSchema, async (req) => {
    const seed = await readSeedByAddress(req.address);
    if (!seed) throw new Error('no such wallet on this device');
    await setActiveAddress(seed.address);
    const st = await signer.status();
    if (!(st.unlocked && sameAccount(st.address, seed.address))) {
      // The session (if any) belongs to a different account: each wallet
      // unlocks with its own password, so drop it and raise the native unlock
      // window for the newly selected account.
      if (st.unlocked) await signer.lock();
      emitLockState(true);
      showUnlock();
    }
    return buildStatus();
  });

  // ---- provisioning -------------------------------------------------------
  // Shared: persist the encrypted seed, make it the active wallet, open a
  // session, and (opt-in) stash the KEK in the OS keychain. Returns the status.
  async function provisionAndUnlock(
    encrypted: Parameters<typeof writeSeed>[0],
    password: string,
    useKeychain: boolean,
  ): Promise<WalletStatus> {
    await writeSeed(encrypted);
    await setActiveAddress(encrypted.address);
    // Keychain provisioning is gated on the renderer's opt-in AND the settings
    // preference (biometricUnlock, default on) AND platform availability.
    const wantKek =
      useKeychain && (await getBiometricUnlockEnabled()) && (await keyVault.isAvailable());
    const autolockMs = await getEffectiveAutolockMs();
    const result = await signer.unlock({ encrypted, autolockMs, password, wantKek });
    if (wantKek && result.kekHex) {
      await keyVault.store(encrypted.address, result.kekHex);
      // result.kekHex is a JS string and cannot be truly zeroized; minimise its
      // lifetime by dropping the only reference now. See THREAT_MODEL.md.
    }
    emitLockState(false);
    notifyUnlocked();
    return buildStatus();
  }

  handle(IPC.CREATE_WALLET, CreateWalletRequestSchema, async (req) => {
    // The signer generates the seed and returns the mnemonic ONCE for backup.
    const { encrypted, mnemonic } = await signer.create(req.password);
    if (await readSeedByAddress(encrypted.address)) {
      throw new Error('this account already exists on this device');
    }
    const status = await provisionAndUnlock(encrypted, req.password, req.useKeychain);
    return { status, mnemonic };
  });

  handle(IPC.IMPORT_WALLET, ImportWalletRequestSchema, async (req) => {
    const source =
      req.mnemonic !== undefined ? { mnemonic: req.mnemonic } : { hexSeed: req.hexSeed };
    const { encrypted } = await signer.importWallet(source, req.password);
    if (await readSeedByAddress(encrypted.address)) {
      throw new Error('this account is already on this device');
    }
    return provisionAndUnlock(encrypted, req.password, req.useKeychain);
  });

  // ---- broadcast ----------------------------------------------------------
  handle(IPC.SEND_RAW_TRANSACTION, SendRawTransactionRequestSchema, (req) =>
    rpc.sendRawTransaction(req.rawTx),
  );

  // ---- desktop settings window ---------------------------------------------
  // The renderer may only ASK main to show/focus the native settings window;
  // no data crosses in either direction and no main-owned setting is readable
  // or writable over the renderer bridge. Rejected while locked: the unlock
  // window must stay the only surface on screen.
  handle(IPC.OPEN_DESKTOP_SETTINGS, null, async () => {
    if (isUnlockWindowShown()) throw new Error('wallet is locked');
    showSettings();
  });

  // ---- dApp-connect attention ---------------------------------------------
  // A restricted dApp request arrived while the window is unfocused/minimised:
  // surface it WITHOUT stealing focus (taskbar flash / dock bounce, and
  // showInactive when hidden). Rate-limited so a compromised renderer can
  // annoy, not strobe; it grants nothing else. Takes no argument.
  let lastAttentionAt = Number.NEGATIVE_INFINITY;
  const ATTENTION_RATE_LIMIT_MS = 5000;
  handle(IPC.DAPP_REQUEST_ATTENTION, null, async () => {
    const now = Date.now();
    if (now - lastAttentionAt < ATTENTION_RATE_LIMIT_MS) return;
    lastAttentionAt = now;
    // The dApp approval modal lives in the wallet renderer: if the settings
    // window is the visible surface (wallet hidden behind it), give the
    // surface back so the request is actually seeable. Worst case for a
    // malicious renderer spamming this: the user's settings window closes,
    // rate-limited; same nuisance tier as the flash itself.
    closeSettingsWindow();
    const win = requireWindow();
    if (!win.isVisible()) win.showInactive();
    if (process.platform === 'darwin') {
      app.dock?.bounce('informational');
    } else {
      // Windows/Linux: flash the taskbar entry; stops on focus.
      win.flashFrame(true);
    }
  });
}
