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
 */
import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { AUTOLOCK_MS } from './config';
import { confirmRemoveWallet, confirmSignature } from './confirm';
import * as rpc from './rpc';
import { deleteSeed, hasSeed, readSeed, writeSeed } from './seedFile';
import { isTrustedSender } from './security';
import type { SignerBridge } from './signerBridge';
import { EVENTS, IPC } from '../shared/constants';
import {
  BuildTransactionRequestSchema,
  CreateWalletRequestSchema,
  GetBalanceRequestSchema,
  ImportWalletRequestSchema,
  SendRawTransactionRequestSchema,
  SignatureRequestSchema,
  UnlockRequestSchema,
  type WalletStatus,
} from '../shared/schemas';
import type { KeyVault } from '../keyvault';

interface Deps {
  getWindow: () => BrowserWindow | null;
  signer: SignerBridge;
  keyVault: KeyVault;
  /** Show the native unlock window (called when the renderer requests a lock). */
  showUnlock: () => void;
}

// Cache ONLY a successful read: rpc.getChainId now throws on an unreachable
// node, so a transient RPC failure can no longer poison the signing chain id
// for the rest of the process lifetime.
let cachedChainId: number | null = null;
async function chainId(): Promise<number> {
  if (cachedChainId === null) cachedChainId = await rpc.getChainId();
  return cachedChainId;
}

export function registerIpcHandlers(deps: Deps): void {
  const { getWindow, signer, keyVault, showUnlock } = deps;

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

  async function buildStatus(): Promise<WalletStatus> {
    const present = await hasSeed();
    const st = await signer.status();
    const seed = present ? await readSeed() : null;
    const keychainBacked = seed ? await keyVault.has(seed.address) : false;
    return {
      hasWallet: present,
      locked: !st.unlocked,
      address: st.address ?? seed?.address ?? null,
      unlockExpiresAt: st.unlockExpiresAt,
      keychainBacked,
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
    const approved = await confirmSignature(requireWindow(), req);
    if (!approved) throw new Error('user rejected signature');
    return signer.sign(req, signingChainId);
  });

  // ---- session ------------------------------------------------------------
  handle(IPC.UNLOCK, UnlockRequestSchema, async (req) => {
    const encrypted = await readSeed();
    if (!encrypted) throw new Error('no wallet to unlock');
    if (req.password) {
      await signer.unlock({ encrypted, autolockMs: AUTOLOCK_MS, password: req.password });
    } else {
      // No password: unlock via a KEK retrieved from the OS keychain.
      const kekHex = await keyVault.retrieve(encrypted.address);
      if (!kekHex) throw new Error('keychain unlock unavailable; password required');
      await signer.unlock({ encrypted, autolockMs: AUTOLOCK_MS, kekHex });
    }
    emitLockState(false);
    return buildStatus();
  });

  handle(IPC.LOCK, null, async () => {
    await signer.lock();
    emitLockState(true);
    // Renderer-initiated lock (auto-lock timer / logout): surface the native
    // unlock window so the session can be reopened with a password. Only when a
    // wallet actually exists, otherwise locking is a no-op and we must not show a
    // dead-end "No wallet to unlock" screen (e.g. right after a wipe).
    if (await hasSeed()) showUnlock();
    return buildStatus();
  });

  // Destructive wallet removal (the "wipe", mirroring the mobile app): drop the
  // session, delete the encrypted seed from disk, and clear the OS-keychain
  // entry. After this hasWallet is false, so the renderer returns to the
  // create/import flow; the unlock window is deliberately NOT shown (there is
  // nothing to unlock). Reachable only behind the renderer's confirmation UI.
  handle(IPC.REMOVE_WALLET, null, async () => {
    // Irreversible + renderer-reachable, so it must be gated by a trusted
    // main-drawn confirmation (default Cancel), exactly like the signing path.
    // The renderer's own confirm UI is convenience, NOT the security gate.
    const approved = await confirmRemoveWallet(requireWindow());
    if (!approved) throw new Error('user rejected wallet removal');
    const seed = await readSeed();
    await signer.lock();
    // Delete the security-relevant ciphertext FIRST so the wallet is
    // unrecoverable even if the keychain clear then fails (a bare KEK with no
    // matching ciphertext is useless). Log, do not swallow, a clear failure.
    await deleteSeed();
    if (seed) {
      await keyVault
        .delete(seed.address)
        .catch((err) => console.error('removeWallet: keychain clear failed', err));
    }
    return buildStatus();
  });

  handle(IPC.GET_STATUS, null, () => buildStatus());

  handle(IPC.HAS_WALLET, null, () => hasSeed());

  // ---- provisioning -------------------------------------------------------
  // Shared: persist the encrypted seed, open a session, and (opt-in) stash the
  // KEK in the OS keychain. Returns the live status.
  async function provisionAndUnlock(
    encrypted: Parameters<typeof writeSeed>[0],
    password: string,
    useKeychain: boolean,
  ): Promise<WalletStatus> {
    await writeSeed(encrypted);
    const wantKek = useKeychain && (await keyVault.isAvailable());
    const result = await signer.unlock({ encrypted, autolockMs: AUTOLOCK_MS, password, wantKek });
    if (wantKek && result.kekHex) {
      await keyVault.store(encrypted.address, result.kekHex);
      // result.kekHex is a JS string and cannot be truly zeroized; minimise its
      // lifetime by dropping the only reference now. See THREAT_MODEL.md.
    }
    emitLockState(false);
    return buildStatus();
  }

  handle(IPC.CREATE_WALLET, CreateWalletRequestSchema, async (req) => {
    if (await hasSeed()) throw new Error('a wallet already exists; remove it first');
    // The signer generates the seed and returns the mnemonic ONCE for backup.
    const { encrypted, mnemonic } = await signer.create(req.password);
    const status = await provisionAndUnlock(encrypted, req.password, req.useKeychain);
    return { status, mnemonic };
  });

  handle(IPC.IMPORT_WALLET, ImportWalletRequestSchema, async (req) => {
    if (await hasSeed()) throw new Error('a wallet already exists; remove it first');
    const { encrypted } = await signer.importWallet(req.mnemonic, req.password);
    return provisionAndUnlock(encrypted, req.password, req.useKeychain);
  });

  // ---- broadcast ----------------------------------------------------------
  handle(IPC.SEND_RAW_TRANSACTION, SendRawTransactionRequestSchema, (req) =>
    rpc.sendRawTransaction(req.rawTx),
  );
}
