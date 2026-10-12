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

export function messageRequest(value: string | Uint8Array, origin?: DAppOrigin) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return SignatureRequestSchema.parse({
    kind: 'message',
    signer: SIGNER,
    messageHex: `0x${bytes.toString('hex')}`,
    ...(origin ? { origin } : {}),
  });
}
