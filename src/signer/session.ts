/**
 * In-memory unlocked session for the signer process.
 *
 * Design choice (see THREAT_MODEL.md): we hold the 32-byte KEK in memory for
 * the session and re-derive the plaintext seed from the on-disk ciphertext on
 * EACH sign, wiping it immediately after. This keeps the actual seed/secret
 * key resident only for the few milliseconds of a signature, rather than for
 * the whole session, at the cost of one extra AES-GCM decrypt per sign (cheap).
 * The KEK is wiped on lock, on the autolock timer, and on process exit.
 */
import { aesGcmDecrypt, type AeadEnvelope } from './aead';
import { deriveKek } from './kdf';
import { addressFromHexSeed } from './signing';
import { wipe } from './zeroize';
import type { EncryptedSeed } from '../shared/protocol';

const DEPLOYED_ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;

interface UnlockedState {
  kek: Buffer;
  encrypted: EncryptedSeed;
  address: string;
  autolockMs: number;
  expiresAt: number;
  autolockTimer: NodeJS.Timeout;
}

/** Build a decryptable envelope from the SEED segment (never the mnemonic). */
function seedEnvelopeOf(enc: EncryptedSeed): AeadEnvelope {
  return {
    iv: Buffer.from(enc.seed.iv, 'hex'),
    ciphertext: Buffer.from(enc.seed.ciphertext, 'hex'),
    tag: Buffer.from(enc.seed.tag, 'hex'),
  };
}

export class SignerSession {
  private state: UnlockedState | null = null;

  constructor(private readonly onAutoLock: () => void) {}

  get unlocked(): boolean {
    return this.state !== null;
  }

  get address(): string | null {
    return this.state?.address ?? null;
  }

  get expiresAt(): number | null {
    return this.state?.expiresAt ?? null;
  }

  /**
   * Open a session. Either `password` (KEK derived via Argon2id) or `kek`
   * (already-derived, from the keychain) must be supplied. The KEK is validated
   * by performing one decrypt; on success the seed buffer is wiped immediately
   * and only the KEK is retained.
   */
  async unlock(
    encrypted: EncryptedSeed,
    autolockMs: number,
    secret: { password: string } | { kek: Buffer },
    now: number,
  ): Promise<void> {
    this.lock(); // tear down any prior session first
    if (!DEPLOYED_ADDRESS_RE.test(encrypted.address)) {
      throw new Error('invalid wallet address metadata');
    }
    let kek: Buffer;
    if ('password' in secret) {
      kek = await deriveKek(secret.password, Buffer.from(encrypted.salt, 'hex'), encrypted.kdf);
    } else {
      kek = Buffer.from(secret.kek); // copy so our wipe owns it
    }
    let retainedKek = false;
    try {
      // Authenticate the ciphertext and bind its decrypted seed to the public
      // address metadata before that address can name an unlocked session.
      // Without this check a locally edited envelope could make the trusted
      // confirmation name one account while message signing used another key.
      const seed = aesGcmDecrypt(seedEnvelopeOf(encrypted), kek);
      try {
        const derivedAddress = addressFromHexSeed(seed.toString('utf8'));
        if (derivedAddress.toLowerCase() !== encrypted.address.toLowerCase()) {
          throw new Error('encrypted seed identity does not match wallet metadata');
        }
      } finally {
        wipe(seed);
      }

      const autolockTimer = setTimeout(() => this.handleAutoLock(), autolockMs);
      // Do not keep the Node event loop alive solely for the autolock timer.
      if (typeof autolockTimer.unref === 'function') autolockTimer.unref();
      this.state = {
        kek,
        encrypted,
        address: encrypted.address,
        autolockMs,
        expiresAt: now + autolockMs,
        autolockTimer,
      };
      retainedKek = true;
    } finally {
      // A wrong password, corrupt ciphertext, or identity mismatch must not
      // leave an unowned derived KEK resident in the signer process.
      if (!retainedKek) wipe(kek);
    }
  }

  /**
   * Run `fn` with the freshly decrypted hex extended seed, guaranteeing the
   * plaintext seed Buffer is wiped afterwards. Resets the autolock timer.
   * Throws if locked.
   */
  withSeed<T>(fn: (hexSeed: string) => T, now: number): T {
    if (!this.state) throw new Error('locked');
    const seedBuf = aesGcmDecrypt(seedEnvelopeOf(this.state.encrypted), this.state.kek);
    try {
      // The seed segment is exactly the hex extended seed (no mnemonic, no
      // JSON). It is a JS string and cannot be truly zeroized (V8 immutable
      // strings); it lives only for the duration of fn. See THREAT_MODEL.md.
      const hexSeed = seedBuf.toString('utf8');
      const result = fn(hexSeed);
      this.bumpTimer(now);
      return result;
    } finally {
      wipe(seedBuf);
    }
  }

  /** Async counterpart of {@link withSeed} for the web3 transaction path. The
   * plaintext seed Buffer is held until the promise settles, then wiped. */
  async withSeedAsync<T>(fn: (hexSeed: string) => Promise<T>, now: number): Promise<T> {
    if (!this.state) throw new Error('locked');
    const seedBuf = aesGcmDecrypt(seedEnvelopeOf(this.state.encrypted), this.state.kek);
    try {
      const hexSeed = seedBuf.toString('utf8');
      const result = await fn(hexSeed);
      this.bumpTimer(now);
      return result;
    } finally {
      wipe(seedBuf);
    }
  }

  /** Export the KEK as hex for keychain provisioning. Caller must wipe nothing
   * (returns a fresh hex string); the in-session KEK Buffer stays intact. */
  exportKekHex(): string {
    if (!this.state) throw new Error('locked');
    return this.state.kek.toString('hex');
  }

  /**
   * Change the autolock bound of an OPEN session and re-arm the idle timer
   * immediately (shrinking the window applies now, not at the next unlock).
   * No-op while locked: the new bound arrives with the next unlock request.
   */
  setAutolock(autolockMs: number, now: number): void {
    if (!this.state) return;
    this.state.autolockMs = autolockMs;
    this.bumpTimer(now);
  }

  /** Sliding-window reset: a successful sign extends the session by the full
   * autolock interval from `now`. */
  private bumpTimer(now: number): void {
    if (!this.state) return;
    clearTimeout(this.state.autolockTimer);
    this.state.expiresAt = now + this.state.autolockMs;
    const t = setTimeout(() => this.handleAutoLock(), this.state.autolockMs);
    if (typeof t.unref === 'function') t.unref();
    this.state.autolockTimer = t;
  }

  private handleAutoLock(): void {
    this.lock();
    this.onAutoLock();
  }

  /** Zeroize the KEK and drop all session state. Idempotent. */
  lock(): void {
    if (this.state) {
      clearTimeout(this.state.autolockTimer);
      wipe(this.state.kek);
      this.state = null;
    }
  }
}
