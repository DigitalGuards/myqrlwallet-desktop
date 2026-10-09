/**
 * Runtime guards for the private main <-> signer channel and the persisted
 * envelope. Both ends of the channel treat the other as untrusted wire input:
 * a message that does not parse is dropped (signer) or rejected (main), and no
 * guard ever returns partial data.
 */
import { isQrlAddress } from './address';
import type { KdfParams } from './constants';
import { isRecord } from './guards';
import type {
  AeadFields,
  CreateResult,
  EncryptedSeed,
  ImportResult,
  SignerRequest,
  SignerStatus,
  UnlockResult,
} from './protocol';
import { SignatureRequestSchema } from './schemas';

// ---- Persisted envelope -------------------------------------------------------

export function isAeadFields(v: unknown): v is AeadFields {
  return (
    isRecord(v) &&
    typeof v['iv'] === 'string' &&
    typeof v['ciphertext'] === 'string' &&
    typeof v['tag'] === 'string'
  );
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Every Argon2id field must be a usable integer before the signer sees it. */
export function isKdfParams(v: unknown): v is KdfParams {
  return (
    isRecord(v) &&
    isInt(v['algorithm']) &&
    isInt(v['version']) &&
    isPositiveInt(v['memoryCost']) &&
    isPositiveInt(v['timeCost']) &&
    isPositiveInt(v['parallelism']) &&
    isPositiveInt(v['outputLen']) &&
    isPositiveInt(v['saltBytes'])
  );
}

/** Structural check so a JSON-valid but wrong-shaped file counts as corrupt
 * so it never surfaces as a confusing decrypt error in the signer.
 * Pre-QIP-55 Q+40 envelopes deliberately fail this current-chain check and
 * remain untouched on disk. Migrating one requires decrypting its seed and
 * deriving the complete Q+128 identity with explicit user authorization. */
export function isEncryptedSeed(v: unknown): v is EncryptedSeed {
  return (
    isRecord(v) &&
    typeof v['version'] === 'string' &&
    isQrlAddress(v['address']) &&
    typeof v['salt'] === 'string' &&
    isKdfParams(v['kdf']) &&
    isAeadFields(v['seed']) &&
    isAeadFields(v['mnemonic']) &&
    (v['createdAt'] === undefined || typeof v['createdAt'] === 'number')
  );
}

// ---- Requests (main -> signer), parsed in the signer ------------------------------

function optionalString(o: Record<string, unknown>, key: string): string | undefined | null {
  const v = o[key];
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : null;
}

function isAutolockMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Parse one inbound message into a SignerRequest, or null when it is not a
 * well-formed request (the caller drops it). */
export function parseSignerRequest(data: unknown): SignerRequest | null {
  if (!isRecord(data)) return null;
  const id = data['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  switch (data['type']) {
    case 'signer:create': {
      const password = data['password'];
      if (typeof password !== 'string') return null;
      return { type: 'signer:create', id, password };
    }
    case 'signer:import': {
      const password = data['password'];
      const mnemonic = optionalString(data, 'mnemonic');
      const hexSeed = optionalString(data, 'hexSeed');
      if (typeof password !== 'string' || mnemonic === null || hexSeed === null) return null;
      return {
        type: 'signer:import',
        id,
        password,
        ...(mnemonic === undefined ? {} : { mnemonic }),
        ...(hexSeed === undefined ? {} : { hexSeed }),
      };
    }
    case 'signer:unlock': {
      const encrypted = data['encrypted'];
      const autolockMs = data['autolockMs'];
      const password = optionalString(data, 'password');
      const kekHex = optionalString(data, 'kekHex');
      const wantKek = data['wantKek'];
      if (
        !isEncryptedSeed(encrypted) ||
        !isAutolockMs(autolockMs) ||
        password === null ||
        kekHex === null ||
        (wantKek !== undefined && typeof wantKek !== 'boolean')
      ) {
        return null;
      }
      return {
        type: 'signer:unlock',
        id,
        encrypted,
        autolockMs,
        ...(password === undefined ? {} : { password }),
        ...(kekHex === undefined ? {} : { kekHex }),
        ...(wantKek === undefined ? {} : { wantKek }),
      };
    }
    case 'signer:sign': {
      const parsed = SignatureRequestSchema.safeParse(data['request']);
      const chainId = data['chainId'];
      if (!parsed.success || !isPositiveInt(chainId)) return null;
      return { type: 'signer:sign', id, request: parsed.data, chainId };
    }
    case 'signer:setAutolock': {
      const autolockMs = data['autolockMs'];
      if (!isAutolockMs(autolockMs)) return null;
      return { type: 'signer:setAutolock', id, autolockMs };
    }
    case 'signer:lock':
      return { type: 'signer:lock', id };
    case 'signer:status':
      return { type: 'signer:status', id };
    case 'signer:shutdown':
      return { type: 'signer:shutdown', id };
    default:
      return null;
  }
}

// ---- Responses (signer -> main), parsed in main -----------------------------------

export type SignerMessage =
  | { kind: 'ready' }
  | { kind: 'autolock' }
  | { kind: 'ok'; id: number; result: unknown }
  | { kind: 'err'; id: number; error: string };

/** Parse one message from the signer, or null when it is malformed. */
export function parseSignerMessage(data: unknown): SignerMessage | null {
  if (!isRecord(data)) return null;
  if (data['type'] === 'signer:ready') return { kind: 'ready' };
  if (data['type'] === 'signer:autolock') return { kind: 'autolock' };
  const id = data['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  if (data['ok'] === true) return { kind: 'ok', id, result: data['result'] };
  const error = data['error'];
  if (data['ok'] === false && typeof error === 'string') return { kind: 'err', id, error };
  return null;
}

/** A result parser either returns the typed value or throws. */
export type ResultParser<T> = (value: unknown) => T;

function malformed(what: string): Error {
  return new Error(`signer returned a malformed ${what}`);
}

export const parseCreateResult: ResultParser<CreateResult> = (v) => {
  if (
    isRecord(v) &&
    isQrlAddress(v['address']) &&
    isEncryptedSeed(v['encrypted']) &&
    typeof v['mnemonic'] === 'string'
  ) {
    return { address: v['address'], encrypted: v['encrypted'], mnemonic: v['mnemonic'] };
  }
  throw malformed('create result');
};

export const parseImportResult: ResultParser<ImportResult> = (v) => {
  if (isRecord(v) && isQrlAddress(v['address']) && isEncryptedSeed(v['encrypted'])) {
    return { address: v['address'], encrypted: v['encrypted'] };
  }
  throw malformed('import result');
};

export const parseUnlockResult: ResultParser<UnlockResult> = (v) => {
  if (
    isRecord(v) &&
    isQrlAddress(v['address']) &&
    typeof v['unlockExpiresAt'] === 'number' &&
    (v['kekHex'] === undefined || typeof v['kekHex'] === 'string')
  ) {
    return {
      address: v['address'],
      unlockExpiresAt: v['unlockExpiresAt'],
      ...(typeof v['kekHex'] === 'string' ? { kekHex: v['kekHex'] } : {}),
    };
  }
  throw malformed('unlock result');
};

export const parseSignerStatus: ResultParser<SignerStatus> = (v) => {
  if (
    isRecord(v) &&
    typeof v['unlocked'] === 'boolean' &&
    (v['address'] === null || typeof v['address'] === 'string') &&
    (v['unlockExpiresAt'] === null || typeof v['unlockExpiresAt'] === 'number')
  ) {
    return {
      unlocked: v['unlocked'],
      address: v['address'],
      unlockExpiresAt: v['unlockExpiresAt'],
    };
  }
  throw malformed('status');
};

export const parseNullResult: ResultParser<null> = (v) => {
  if (v === null) return null;
  throw malformed('acknowledgement');
};
