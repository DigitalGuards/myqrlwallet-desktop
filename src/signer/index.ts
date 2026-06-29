/**
 * The signer utilityProcess entry point.
 *
 * This is the highest-trust, most-isolated component: the ONLY process in
 * which plaintext key material (mnemonic, seed, ML-DSA-87 secret key) is ever
 * materialised. It is forked by main via `utilityProcess.fork` and speaks ONLY
 * to main over `process.parentPort`. The renderer has no handle to it.
 *
 * It exposes a single narrow verb set (import / unlock / sign / lock / status)
 * and performs no I/O of its own beyond the optional web3 provider used to
 * sign transactions. It never reads or writes the seed file (main owns disk),
 * never logs secrets, and zeroizes every secret buffer on its way out.
 */
/// <reference types="electron" />
// The reference above loads electron's global augmentation of NodeJS.Process,
// which declares `process.parentPort` (typed Electron.ParentPort; only present
// in a utilityProcess child). ParentPort lives in the global Electron namespace,
// not as a module export, so it is referenced as Electron.ParentPort below.
import { randomBytes } from 'node:crypto';
import { aesGcmEncrypt } from './aead';
import { deriveKek } from './kdf';
import { SignerSession } from './session';
import { deriveSeedFromMnemonic, signMessage, signTransaction } from './signing';
import { wipe } from './zeroize';
import { KDF_DEFAULTS, SEED_FILE_VERSION } from '../shared/constants';
import type { EncryptedSeed, SignerOutbound, SignerRequest } from '../shared/protocol';

// process.parentPort exists only inside a utilityProcess.fork child.
const parentPort: Electron.ParentPort | undefined = process.parentPort;
if (!parentPort) {
  // Not launched by Electron utilityProcess; refuse to run (defense against
  // being executed as a plain node script that could be coaxed into signing).
  throw new Error('signer must be launched via utilityProcess.fork');
}

function send(msg: SignerOutbound): void {
  parentPort!.postMessage(msg);
}

const session = new SignerSession(() => send({ type: 'signer:autolock' }));

/** Provision a fresh encrypted-seed envelope from a mnemonic + password. */
async function handleImport(
  mnemonic: string,
  password: string,
): Promise<{ address: string; encrypted: EncryptedSeed }> {
  const { hexSeed, address } = deriveSeedFromMnemonic(mnemonic);
  const salt = randomBytes(KDF_DEFAULTS.saltBytes);
  const kek = await deriveKek(password, salt, KDF_DEFAULTS);
  // Encrypt the hex seed and the mnemonic SEPARATELY under the same KEK, so the
  // signing path only ever decrypts the hex seed (never the recovery mnemonic).
  const seedBuf = Buffer.from(hexSeed, 'utf8');
  const mnemonicBuf = Buffer.from(mnemonic, 'utf8');
  try {
    const seedEnv = aesGcmEncrypt(seedBuf, kek);
    const mnemonicEnv = aesGcmEncrypt(mnemonicBuf, kek);
    const encrypted: EncryptedSeed = {
      version: SEED_FILE_VERSION,
      address,
      kdf: { ...KDF_DEFAULTS },
      salt: salt.toString('hex'),
      seed: {
        iv: seedEnv.iv.toString('hex'),
        ciphertext: seedEnv.ciphertext.toString('hex'),
        tag: seedEnv.tag.toString('hex'),
      },
      mnemonic: {
        iv: mnemonicEnv.iv.toString('hex'),
        ciphertext: mnemonicEnv.ciphertext.toString('hex'),
        tag: mnemonicEnv.tag.toString('hex'),
      },
      createdAt: Date.now(),
    };
    return { address, encrypted };
  } finally {
    wipe(seedBuf);
    wipe(mnemonicBuf);
    wipe(kek);
  }
}

async function handle(req: SignerRequest): Promise<void> {
  const now = Date.now();
  try {
    switch (req.type) {
      case 'signer:import': {
        const result = await handleImport(req.mnemonic, req.password);
        send({ id: req.id, ok: true, type: 'signer:import', result });
        return;
      }
      case 'signer:unlock': {
        if (req.kekHex) {
          const kek = Buffer.from(req.kekHex, 'hex');
          try {
            await session.unlock(req.encrypted, req.autolockMs, { kek }, now);
          } finally {
            wipe(kek);
          }
        } else if (typeof req.password === 'string') {
          await session.unlock(req.encrypted, req.autolockMs, { password: req.password }, now);
        } else {
          throw new Error('unlock requires a password or a keychain KEK');
        }
        const kekHex = req.wantKek && !req.kekHex ? session.exportKekHex() : undefined;
        send({
          id: req.id,
          ok: true,
          type: 'signer:unlock',
          result: { address: session.address!, unlockExpiresAt: session.expiresAt!, kekHex },
        });
        return;
      }
      case 'signer:sign': {
        if (!session.unlocked) throw new Error('locked');
        const { request } = req;
        if (request.kind === 'transaction') {
          // req.chainId is authoritative (main read it from the node); the
          // signer binds the signed tx to it and ignores any renderer tx.chainId.
          const result = await session.withSeedAsync(
            (hexSeed) => signTransaction(hexSeed, request.tx, req.chainId),
            now,
          );
          send({ id: req.id, ok: true, type: 'signer:sign', result });
        } else if (request.kind === 'message') {
          const result = session.withSeed(
            (hexSeed) => signMessage(hexSeed, request.messageHex),
            now,
          );
          send({ id: req.id, ok: true, type: 'signer:sign', result });
        } else {
          // typedData: the byte-exact EIP-712-style hasher
          // (myqrlwallet-frontend src/utils/signing/typedData.ts) is not yet
          // ported into the desktop signer. Fail loudly rather than emit a
          // signature over a digest the dApp side would not reproduce.
          throw new Error('typedData signing not yet wired in desktop scaffold; port typedData.ts');
        }
        return;
      }
      case 'signer:lock': {
        session.lock();
        send({ id: req.id, ok: true, type: 'signer:lock', result: null });
        return;
      }
      case 'signer:status': {
        send({
          id: req.id,
          ok: true,
          type: 'signer:status',
          result: {
            unlocked: session.unlocked,
            address: session.address,
            unlockExpiresAt: session.expiresAt,
          },
        });
        return;
      }
      case 'signer:shutdown': {
        session.lock();
        send({ id: req.id, ok: true, type: 'signer:shutdown', result: null });
        // Give the message a tick to flush, then exit.
        setTimeout(() => process.exit(0), 50);
        return;
      }
      default: {
        const _exhaustive: never = req;
        throw new Error(`unknown signer request ${(_exhaustive as { type?: string }).type}`);
      }
    }
  } catch (err) {
    // Never echo the password or any secret; only a short message.
    const error = err instanceof Error ? err.message : 'signer error';
    send({ id: (req as { id?: number }).id ?? -1, ok: false, error });
  }
}

parentPort.on('message', (e: { data: SignerRequest }) => {
  void handle(e.data);
});

// Wipe on unexpected termination paths too.
process.on('exit', () => session.lock());

// Announce readiness so main can resolve its fork promise.
send({ type: 'signer:ready' });
