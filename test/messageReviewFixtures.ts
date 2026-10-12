import { SIGNATURE_APPROVAL_NOTE } from '../src/main/confirmSummary';
import { groupQrlAddress } from '../src/shared/address';
import { SignatureRequestSchema, type DAppOrigin } from '../src/shared/schemas';
import { SIGNER } from './typedDataFixtures';

export const QUANTASWAP_ORDER = {
  maker: SIGNER,
  makerAsset: `Q${'11'.repeat(64)}`,
  takerAsset: `Q${'22'.repeat(64)}`,
  memo: Array.from(
    { length: 16 },
    (_, i) => `order-section-${i.toString().padStart(2, '0')}:${'x'.repeat(48)}`,
  ).join('|'),
  makerAmount: '1234567890000000000000',
  takerAmount: '9876543210000000000000',
  expiry: '1799999999',
};

export const QUANTASWAP_MESSAGE = `QuantaSwap Protocol V2\0${JSON.stringify([QUANTASWAP_ORDER])}`;

// Space padding positions forged chrome at the original 64-column row boundaries.
export const DIALOG_CHROME_MESSAGE = [
  'sell 1 Quanta at market; expiry 5m'.padEnd(64),
  ' '.repeat(64),
  SIGNATURE_APPROVAL_NOTE.padEnd(64),
  ' '.repeat(128),
  `Account:   ${groupQrlAddress(SIGNER)}`.padEnd(192),
  'Page 1 of 1'.padEnd(64),
  'Message (text, 61 bytes):'.padEnd(63),
  'sell 100000 Quanta at market; expiry 1y'.padEnd(65),
].join('');

export const GTK_WRAP_MESSAGE = [
  'sell 1 Quanta at market; expiry 5m'.padEnd(48),
  ' '.repeat(16),
  SIGNATURE_APPROVAL_NOTE,
  'Account: forged  ',
  'Page 1 of 1  ',
  'Message (text, 247 bytes):  ',
  'sell 100000 Quanta at market; expiry 1y',
]
  .join('')
  .padEnd(247);

export function messageRequest(value: string | Uint8Array, origin?: DAppOrigin) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return SignatureRequestSchema.parse({
    kind: 'message',
    signer: SIGNER,
    messageHex: `0x${bytes.toString('hex')}`,
    ...(origin ? { origin } : {}),
  });
}
