/**
 * Status words and errors for the QRL v2.0 Ledger app.
 *
 * App status words come from theQRL/ledger-app-qrl-v2 (`src/sw.h`); the BOLOS
 * ones (locked device, dashboard answers) are Ledger's standard codes. The
 * builds in circulation answer a disabled Blind signing setting differently:
 * the theQRL build returns 6985 before showing anything (the same word as a
 * user rejection) and the cyyber builds show a notice and return B008. A
 * refused request that needed Blind signing therefore carries
 * `needsBlindSigning`, so the caller can name the setting next to the plain
 * meaning of the status.
 */

export const SW = {
  OK: 0x9000,
  DENY: 0x6985,
  WRONG_P1P2: 0x6a86,
  WRONG_DATA_LENGTH: 0x6a87,
  INS_NOT_SUPPORTED: 0x6d00,
  CLA_NOT_SUPPORTED: 0x6e00,
  WRONG_TX_LENGTH: 0xb004,
  TX_PARSING_FAIL: 0xb005,
  TX_HASH_FAIL: 0xb006,
  BAD_STATE: 0xb007,
  SIGNATURE_FAIL: 0xb008,
  LOCKED_DEVICE: 0x5515,
  CLA_NOT_SUPPORTED_DASHBOARD: 0x6e01,
  UNKNOWN_APDU: 0x6d02,
  APP_NOT_FOUND: 0x5123,
} as const;

export type LedgerErrorCode =
  | 'transport'
  | 'locked'
  | 'wrong-app'
  | 'unsupported'
  | 'rejected'
  | 'tx-too-large'
  | 'tx-invalid'
  | 'bad-state'
  | 'signature-failed'
  | 'device-error'
  | 'malformed-response'
  | 'key-mismatch'
  | 'invalid-path'
  | 'invalid-preimage';

export interface LedgerErrorDetails {
  /** Status word, when the device answered with one. */
  sw?: number;
  /** The refused request carried calldata or an access list (a blind sign). */
  needsBlindSigning?: boolean;
}

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly sw: number | undefined;
  readonly needsBlindSigning: boolean;

  constructor(code: LedgerErrorCode, message: string, details: LedgerErrorDetails = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.sw = details.sw;
    this.needsBlindSigning = details.needsBlindSigning ?? false;
  }
}

function hexWord(sw: number): string {
  return `0x${sw.toString(16).padStart(4, '0')}`;
}

/** Map a non-success status word to a typed error. */
export function statusError(sw: number, needsBlindSigning = false): LedgerError {
  switch (sw) {
    case SW.DENY:
      return new LedgerError('rejected', 'Rejected on the Ledger', { sw, needsBlindSigning });
    case SW.LOCKED_DEVICE:
      return new LedgerError('locked', 'The Ledger is locked', { sw });
    case SW.CLA_NOT_SUPPORTED:
    case SW.CLA_NOT_SUPPORTED_DASHBOARD:
    case SW.UNKNOWN_APDU:
    case SW.APP_NOT_FOUND:
      return new LedgerError('wrong-app', 'The QRL v2.0 app is not open on the Ledger', { sw });
    case SW.INS_NOT_SUPPORTED:
      return new LedgerError('unsupported', 'The QRL v2.0 app does not support this request', {
        sw,
      });
    case SW.WRONG_TX_LENGTH:
      return new LedgerError('tx-too-large', 'The transaction is too large for the Ledger app', {
        sw,
      });
    case SW.TX_PARSING_FAIL:
    case SW.TX_HASH_FAIL:
      return new LedgerError('tx-invalid', 'The Ledger app could not read the transaction', { sw });
    case SW.BAD_STATE:
      return new LedgerError('bad-state', 'The Ledger app is in an unexpected state', { sw });
    case SW.SIGNATURE_FAIL:
      return new LedgerError('signature-failed', 'The Ledger did not produce a signature', {
        sw,
        needsBlindSigning,
      });
    default:
      return new LedgerError('device-error', `The Ledger answered ${hexWord(sw)}`, { sw });
  }
}
