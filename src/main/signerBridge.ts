/**
 * Main-side proxy to the signer utilityProcess.
 *
 * The renderer NEVER holds a handle to the signer. This bridge is the only
 * thing that calls `child.postMessage` and listens on `child.on('message')`,
 * enforcing the path renderer -> preload -> main -> signer. Requests are
 * correlated by a monotonic id; responses resolve the matching pending promise.
 */
import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  CreateResult,
  EncryptedSeed,
  ImportResult,
  SignerOutbound,
  SignerRequest,
  SignerStatus,
  UnlockResult,
} from '../shared/protocol';
import type { SignatureRequest, SignatureResult } from '../shared/schemas';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Distributive Omit so each member of the SignerRequest union keeps its own
 * fields when `id` is stripped. A plain `Omit<SignerRequest, 'id'>` collapses
 * the union to its common keys (just `type`) and rejects member-specific props.
 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type SignerRequestPayload = WithoutId<SignerRequest>;

const REQUEST_TIMEOUT_MS = 120_000; // generous: Argon2id can take ~0.5-1.5s
const READY_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 3;

/**
 * Pass the signer a MINIMAL environment. The signer holds keys, so it should
 * not inherit arbitrary parent-shell variables (which during a build can
 * include APPLE_API_KEY, signing passwords, etc.). It needs no app config of
 * its own (signing is fully offline), only the handful of OS vars that native
 * module loading may rely on.
 */
function minimalSignerEnv(): Record<string, string> {
  const allow = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'windir',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ];
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = process.env[k];
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

export class SignerBridge {
  private child: UtilityProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private restarts = 0;
  private shuttingDown = false;
  private modulePath: string;

  constructor(private readonly onSessionDropped: () => void) {
    this.modulePath = path.join(__dirname, 'signer.js');
  }

  /** Fork the signer and resolve once it reports ready, or reject if it dies
   * or fails to report ready within the startup timeout. Call once at boot. */
  start(signerModulePath?: string): Promise<void> {
    if (signerModulePath) this.modulePath = signerModulePath;
    return this.fork();
  }

  private fork(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const startupTimer = setTimeout(() => {
      this.readyReject?.(new Error('signer did not report ready in time'));
      this.readyReject = null;
      this.readyResolve = null;
      this.child?.kill();
    }, READY_TIMEOUT_MS);
    if (typeof startupTimer.unref === 'function') startupTimer.unref();

    const child = utilityProcess.fork(this.modulePath, [], {
      serviceName: 'qrl-signer',
      // stdin must be 'ignore'; keep stdout/stderr off in production.
      stdio: 'ignore',
      env: minimalSignerEnv(),
    });
    this.child = child;

    child.on('message', (msg: SignerOutbound) => {
      if ('type' in msg && msg.type === 'signer:ready') clearTimeout(startupTimer);
      this.onMessage(msg);
    });
    child.on('exit', (code) => this.onExit(code));
    return ready;
  }

  private onMessage(msg: SignerOutbound): void {
    if ('type' in msg && msg.type === 'signer:ready') {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if ('type' in msg && msg.type === 'signer:autolock') {
      this.onSessionDropped();
      return;
    }
    if ('id' in msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve((msg as { result: unknown }).result);
      else p.reject(new Error(msg.error));
    }
  }

  private onExit(code: number): void {
    // Reject everything in flight; the signer is gone.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`signer exited (code ${code})`));
    }
    this.pending.clear();
    // Reject a still-pending startup so boot does not hang forever.
    this.readyReject?.(new Error(`signer exited before ready (code ${code})`));
    this.readyReject = null;
    this.readyResolve = null;
    this.child = null;

    if (this.shuttingDown) return;
    // Unexpected crash: any unlocked session died with the process, so tell the
    // renderer it is locked, then attempt a bounded auto-restart so the wallet
    // is not permanently wedged.
    this.onSessionDropped();
    if (this.restarts < MAX_RESTARTS) {
      this.restarts += 1;
      void this.fork().catch(() => undefined);
    }
  }

  private send<T>(req: SignerRequestPayload): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('signer not running'));
    const id = this.nextId++;
    const full = { ...req, id } as SignerRequest;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('signer request timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.postMessage(full);
    });
  }

  create(password: string): Promise<CreateResult> {
    return this.send<CreateResult>({ type: 'signer:create', password });
  }

  /** Import from a mnemonic OR a hex extended seed (exactly one). */
  importWallet(
    source: { mnemonic?: string; hexSeed?: string },
    password: string,
  ): Promise<ImportResult> {
    return this.send<ImportResult>({ type: 'signer:import', ...source, password });
  }

  unlock(args: {
    encrypted: EncryptedSeed;
    autolockMs: number;
    password?: string;
    kekHex?: string;
    wantKek?: boolean;
  }): Promise<UnlockResult> {
    return this.send<UnlockResult>({ type: 'signer:unlock', ...args });
  }

  sign(request: SignatureRequest, chainId: number): Promise<SignatureResult> {
    return this.send<SignatureResult>({ type: 'signer:sign', request, chainId });
  }

  lock(): Promise<null> {
    return this.send<null>({ type: 'signer:lock' });
  }

  /** Re-arm the open session's autolock timer with a new bound (no-op success
   * while locked). Main <-> signer private; never reachable from the renderer. */
  setAutolock(autolockMs: number): Promise<null> {
    return this.send<null>({ type: 'signer:setAutolock', autolockMs });
  }

  status(): Promise<SignerStatus> {
    return this.send<SignerStatus>({ type: 'signer:status' });
  }

  async shutdown(): Promise<void> {
    // Mark shutting-down so onExit does not auto-restart the signer.
    this.shuttingDown = true;
    try {
      await this.send<null>({ type: 'signer:shutdown' });
    } catch {
      /* may already be gone */
    }
    this.child?.kill();
    this.child = null;
  }
}
