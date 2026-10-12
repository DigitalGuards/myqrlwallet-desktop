/**
 * QRL v2.0 Ledger support: APDU client, path and preimage checks, and the
 * development Speculos transport. Nothing here is wired into the app yet; the
 * device process and the account and signing flows build on this module.
 */
export {
  DEFAULT_MAX_PREIMAGE_BYTES,
  QRL_LEDGER_APP_NAME,
  QrlLedger,
  qrlAddressFromPublicKey,
} from './qrlLedger';
export type { LedgerAccount, LedgerAppInfo, LedgerAppVersion, QrlLedgerOptions } from './qrlLedger';
export { LedgerError, SW, statusError } from './errors';
export type { LedgerErrorCode, LedgerErrorDetails } from './errors';
export { encodeQrlPath, parseQrlPath, qrlAccountPath } from './path';
export { inspectPreimage } from './preimage';
export type { PreimageInfo } from './preimage';
export { createSpeculosTransport } from './speculosTransport';
export type { SpeculosTransportOptions } from './speculosTransport';
export type { LedgerTransport } from './transport';
