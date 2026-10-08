/**
 * Client for the QRL v2.0 Ledger app (theQRL/ledger-app-qrl-v2), independent
 * of the transport.
 *
 * Protocol, as exercised against the app on Speculos:
 * - B0 01: BOLOS get app and version; must name `QRL v2.0` before any E0 command,
 *   because other apps share CLA E0.
 * - E0 05, P2=0: derive the account at a path and return `Q` plus its 64-byte
 *   address (P1=1 shows it on the device first). P2=1..11 then return the
 *   2,592-byte ML-DSA-87 public key in chunks (10 x 258 + 12). The chunks are
 *   whatever the last derivation left in device storage, so a derivation and
 *   its chunk reads run as one job and the address is recomputed from the key.
 * - E0 06: P1=0 sends the path, P1=1 streams preimage chunks, P1=2 sends the
 *   last chunk and blocks until the user decides; it answers with signature
 *   chunk 0, and P1=2 with P2=1..17 returns the rest (17 x 258 + 241 = 4,627).
 *
 * The device hashes the preimage with Keccak-256 and signs with the fixed
 * context "ZOND" || 01 || 01 00 00. Verifying a returned signature belongs to
 * the trusted caller; this client checks shapes and the address/key binding.
 * Wherever the client runs, the trusted process repeats the address check.
 */
import { shake256 } from '@noble/hashes/sha3.js';
import { MLDSA87 } from '../shared/constants';
import {
  CLA_BOLOS,
  CLA_QRL,
  INS,
  INS_BOLOS_APP_AND_VERSION,
  MAX_APDU_DATA_BYTES,
  decodeResponse,
  encodeApdu,
} from './apdu';
import { concatBytes, toHex } from './bytes';
import { LedgerError, SW, statusError } from './errors';
import { encodeQrlPath } from './path';
import { inspectPreimage } from './preimage';
import type { LedgerTransport } from './transport';

export const QRL_LEDGER_APP_NAME = 'QRL v2.0';

/** Largest preimage the theQRL build accepts (`MAX_TRANSACTION_LEN`). Other
 * builds accept more, and they report the same name and version, so the
 * strictest value is the default. */
export const DEFAULT_MAX_PREIMAGE_BYTES = 510;

const ADDRESS_BYTES = 64;
const ADDRESS_PREFIX = 0x51; // 'Q'
const MLDSA87_DESCRIPTOR = Uint8Array.from([0x01, 0x00, 0x00]);
const PK_CHUNKS = 11;
const PK_CHUNK_BYTES = 258;
const SIG_CHUNKS = 18;
const SIG_CHUNK_BYTES = 258;
const SIG_LAST_CHUNK_BYTES = MLDSA87.SIGNATURE_BYTES - (SIG_CHUNKS - 1) * SIG_CHUNK_BYTES;
const PK_LAST_CHUNK_BYTES = MLDSA87.PUBLIC_KEY_BYTES - (PK_CHUNKS - 1) * PK_CHUNK_BYTES;

export interface LedgerAppInfo {
  name: string;
  version: string;
}

export interface LedgerAppVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface LedgerAccount {
  path: string;
  /** `Q` plus 128 lowercase hex characters; callers apply checksum casing for display. */
  address: string;
  publicKey: Uint8Array;
}

export interface QrlLedgerOptions {
  maxPreimageBytes?: number;
}

/** The QIP-55 address of an ML-DSA-87 public key: SHAKE256(01 00 00 || pk), 64 bytes. */
export function qrlAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== MLDSA87.PUBLIC_KEY_BYTES) {
    throw new LedgerError('malformed-response', 'Public key has the wrong length');
  }
  const digest = shake256(concatBytes(MLDSA87_DESCRIPTOR, publicKey), { dkLen: ADDRESS_BYTES });
  return `Q${toHex(digest)}`;
}

function malformed(what: string): LedgerError {
  return new LedgerError('malformed-response', `Unexpected Ledger response: ${what}`);
}

export class QrlLedger {
  private readonly transport: LedgerTransport;
  private readonly maxPreimageBytes: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(transport: LedgerTransport, options: QrlLedgerOptions = {}) {
    this.transport = transport;
    this.maxPreimageBytes = options.maxPreimageBytes ?? DEFAULT_MAX_PREIMAGE_BYTES;
  }

  /** Run jobs one at a time so multi-APDU sequences never interleave. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async exchange(apdu: Uint8Array): Promise<{ data: Uint8Array; sw: number }> {
    let response: Uint8Array;
    try {
      response = await this.transport.exchange(apdu);
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new LedgerError('transport', `Ledger transport failed: ${reason}`);
    }
    return decodeResponse(response);
  }

  private async command(apdu: Uint8Array, needsBlindSigning = false): Promise<Uint8Array> {
    const { data, sw } = await this.exchange(apdu);
    if (sw !== SW.OK) throw statusError(sw, needsBlindSigning);
    return data;
  }

  /** Name and version of the open app (or the dashboard), via BOLOS B0 01. */
  getAppInfo(): Promise<LedgerAppInfo> {
    return this.serial(async () => {
      const data = await this.command(encodeApdu(CLA_BOLOS, INS_BOLOS_APP_AND_VERSION, 0, 0));
      if (data[0] !== 0x01) throw malformed('app info format');
      let offset = 1;
      const readString = (): string => {
        const length = data[offset];
        if (length === undefined || offset + 1 + length > data.length) {
          throw malformed('app info length');
        }
        const value = new TextDecoder().decode(data.subarray(offset + 1, offset + 1 + length));
        offset += 1 + length;
        return value;
      };
      const name = readString();
      const version = readString();
      return { name, version };
    });
  }

  /** Throws `wrong-app` unless the QRL v2.0 app is the one open. */
  async requireQrlApp(): Promise<LedgerAppInfo> {
    const info = await this.getAppInfo();
    if (info.name !== QRL_LEDGER_APP_NAME) {
      throw new LedgerError(
        'wrong-app',
        `The open Ledger app is ${JSON.stringify(info.name)}; open ${QRL_LEDGER_APP_NAME}`,
      );
    }
    return info;
  }

  getVersion(): Promise<LedgerAppVersion> {
    return this.serial(async () => {
      const data = await this.command(encodeApdu(CLA_QRL, INS.GET_VERSION, 0, 0));
      if (data.length !== 3) throw malformed('version length');
      return { major: data[0] ?? 0, minor: data[1] ?? 0, patch: data[2] ?? 0 };
    });
  }

  getAppName(): Promise<string> {
    return this.serial(async () => {
      const data = await this.command(encodeApdu(CLA_QRL, INS.GET_APP_NAME, 0, 0));
      return new TextDecoder().decode(data);
    });
  }

  private async deriveAddress(path: string, display: boolean): Promise<string> {
    const data = await this.command(
      encodeApdu(CLA_QRL, INS.GET_PUBLIC_KEY, display ? 1 : 0, 0, encodeQrlPath(path)),
    );
    if (data.length !== 1 + ADDRESS_BYTES || data[0] !== ADDRESS_PREFIX) {
      throw malformed('address response');
    }
    return `Q${toHex(data.subarray(1))}`;
  }

  /** Derive the account at `path` without a device prompt and read its public key. */
  getAccount(path: string): Promise<LedgerAccount> {
    return this.serial(async () => {
      const address = await this.deriveAddress(path, false);
      const chunks: Uint8Array[] = [];
      for (let index = 0; index < PK_CHUNKS; index++) {
        const chunk = await this.command(encodeApdu(CLA_QRL, INS.GET_PUBLIC_KEY, 0, index + 1));
        const expected = index === PK_CHUNKS - 1 ? PK_LAST_CHUNK_BYTES : PK_CHUNK_BYTES;
        if (chunk.length !== expected) throw malformed(`public key chunk ${index} length`);
        chunks.push(chunk);
      }
      const publicKey = concatBytes(...chunks);
      if (qrlAddressFromPublicKey(publicKey) !== address) {
        throw new LedgerError(
          'key-mismatch',
          'The Ledger returned a public key that does not match its address',
        );
      }
      return { path, address, publicKey };
    });
  }

  /** Show the address of `path` on the device; resolves once the user confirms it. */
  verifyAddress(path: string): Promise<string> {
    return this.serial(() => this.deriveAddress(path, true));
  }

  /**
   * Sign an unsigned type 2 preimage (`0x02 || rlp([...11 fields])`). The last
   * APDU waits for the user's decision on the device. Returns the 4,627-byte
   * ML-DSA-87 signature over Keccak-256(preimage).
   */
  async signTransactionPreimage(path: string, preimage: Uint8Array): Promise<Uint8Array> {
    const pathBytes = encodeQrlPath(path);
    const info = inspectPreimage(preimage);
    if (info.length > this.maxPreimageBytes) {
      throw new LedgerError(
        'tx-too-large',
        `The transaction is ${info.length} bytes; the Ledger app accepts at most ${this.maxPreimageBytes}`,
      );
    }
    const blind = info.needsBlindSigning;
    return this.serial(async () => {
      await this.command(encodeApdu(CLA_QRL, INS.SIGN_TX, 0, 0, pathBytes));
      const chunks: Uint8Array[] = [];
      for (let o = 0; o < preimage.length; o += MAX_APDU_DATA_BYTES) {
        chunks.push(preimage.subarray(o, o + MAX_APDU_DATA_BYTES));
      }
      const last = chunks.pop();
      if (!last) throw new LedgerError('invalid-preimage', 'Empty preimage');
      for (const chunk of chunks) {
        await this.command(encodeApdu(CLA_QRL, INS.SIGN_TX, 1, 0, chunk), blind);
      }
      const parts = [await this.command(encodeApdu(CLA_QRL, INS.SIGN_TX, 2, 0, last), blind)];
      for (let index = 1; index < SIG_CHUNKS; index++) {
        parts.push(await this.command(encodeApdu(CLA_QRL, INS.SIGN_TX, 2, index)));
      }
      parts.forEach((part, index) => {
        const expected = index === SIG_CHUNKS - 1 ? SIG_LAST_CHUNK_BYTES : SIG_CHUNK_BYTES;
        if (part.length !== expected) throw malformed(`signature chunk ${index} length`);
      });
      const signature = concatBytes(...parts);
      if (signature.length !== MLDSA87.SIGNATURE_BYTES) throw malformed('signature length');
      return signature;
    });
  }
}
