/**
 * APDU framing for the QRL v2.0 Ledger app (theQRL/ledger-app-qrl-v2) and the
 * BOLOS command that identifies the open app.
 *
 * Command: CLA INS P1 P2 Lc data, with a one-byte Lc and at most 255 data
 * bytes. Response: data followed by a two-byte status word.
 */
import { LedgerError } from './errors';

export const CLA_QRL = 0xe0;
export const CLA_BOLOS = 0xb0;

export const INS = {
  GET_VERSION: 0x03,
  GET_APP_NAME: 0x04,
  GET_PUBLIC_KEY: 0x05,
  SIGN_TX: 0x06,
} as const;

/** BOLOS get-app-and-version: answered by whichever app is open, or the dashboard. */
export const INS_BOLOS_APP_AND_VERSION = 0x01;

export const MAX_APDU_DATA_BYTES = 255;

export function encodeApdu(
  cla: number,
  ins: number,
  p1: number,
  p2: number,
  data: Uint8Array = new Uint8Array(0),
): Uint8Array {
  for (const byte of [cla, ins, p1, p2]) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new RangeError('APDU header byte out of range');
    }
  }
  if (data.length > MAX_APDU_DATA_BYTES) {
    throw new RangeError(`APDU data exceeds ${MAX_APDU_DATA_BYTES} bytes`);
  }
  const out = new Uint8Array(5 + data.length);
  out.set([cla, ins, p1, p2, data.length], 0);
  out.set(data, 5);
  return out;
}

export interface ApduResponse {
  data: Uint8Array;
  sw: number;
}

export function decodeResponse(response: Uint8Array): ApduResponse {
  if (response.length < 2) {
    throw new LedgerError('malformed-response', 'APDU response is shorter than a status word');
  }
  const hi = response[response.length - 2] ?? 0;
  const lo = response[response.length - 1] ?? 0;
  return { data: response.subarray(0, response.length - 2), sw: (hi << 8) | lo };
}
