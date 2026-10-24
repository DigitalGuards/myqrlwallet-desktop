import type { ConfirmContext } from '../src/main/confirmSummary';
import { SignatureRequestSchema, type SignatureRequest } from '../src/shared/schemas';
import { messageRequest } from './messageReviewFixtures';
import { payloadWith, SIGNER, typedRequest } from './typedDataFixtures';
import {
  RECIPIENTS,
  REVIEW_ORIGIN,
  reviewRequest,
  withReviewDomain,
} from './typedDataReviewFixtures';

const tx = {
  type: '0x2',
  from: SIGNER,
  to: SIGNER,
  value: '9'.repeat(40),
  nonce: 42,
  gas: '2000000',
  maxFeePerGas: '9'.repeat(18),
  maxPriorityFeePerGas: '1',
  chainId: 3151909,
  data: '0x' + 'ab'.repeat(40),
};
const urlPrefix = 'https://example.org/';
const metadata = payloadWith('string', 'LAST_SOURCE_FACT');
metadata.types['QRLDomain'] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'salt', type: 'bytes32' },
];
metadata.domain = { name: 'n'.repeat(30), version: 'v'.repeat(30), salt: '0x' + 'ab'.repeat(32) };

/** Schema-valid requests from the native overflow review, plus multi-page bodies. */
export const visibilityCases: {
  name: string;
  request: SignatureRequest;
  context?: ConfirmContext;
}[] = [
  {
    name: 'transaction within allowance',
    request: SignatureRequestSchema.parse({
      kind: 'transaction',
      tx: {
        ...tx,
        value: '1000000000000000000',
        gas: '21000',
        maxFeePerGas: '1',
        maxPriorityFeePerGas: '0',
        data: '0x',
      },
    }),
    context: { build: { estimatedGas: '21000' } },
  },
  {
    name: 'fitting legacy transaction 31 lines',
    request: SignatureRequestSchema.parse({
      kind: 'transaction',
      tx: { ...tx, value: '9', maxFeePerGas: '9' },
      origin: REVIEW_ORIGIN,
    }),
  },
  {
    name: 'fitting legacy transaction 766 pixels',
    request: SignatureRequestSchema.parse({
      kind: 'transaction',
      tx: { ...tx, value: '9', maxFeePerGas: '9'.repeat(40) },
    }),
    context: { build: { estimatedGas: '21000', requestedGas: '2000000' } },
  },
  {
    name: 'transaction gas warning 34 lines',
    request: SignatureRequestSchema.parse({
      kind: 'transaction',
      tx: { ...tx, maxFeePerGas: '9' },
    }),
    context: { build: { estimatedGas: '21000', requestedGas: '2000000' } },
  },
  {
    name: 'transaction 80 digit heading',
    request: SignatureRequestSchema.parse({
      kind: 'transaction',
      tx: { ...tx, value: '9'.repeat(80), maxFeePerGas: '9'.repeat(80) },
      origin: REVIEW_ORIGIN,
    }),
  },
  {
    name: 'transaction 40 18 1 0',
    request: SignatureRequestSchema.parse({ kind: 'transaction', tx, origin: REVIEW_ORIGIN }),
  },
  {
    name: 'transaction invisible URL',
    request: SignatureRequestSchema.parse({
      kind: 'transaction',
      tx: { ...tx, value: '1', nonce: 0, gas: '21000', maxFeePerGas: '1', data: '0x' },
      origin: { ...REVIEW_ORIGIN, url: urlPrefix + '\u200b'.repeat(256 - urlPrefix.length) },
    }),
  },
  { name: 'message 1000 bytes', request: messageRequest('a'.repeat(1000), REVIEW_ORIGIN) },
  { name: 'message page limit', request: messageRequest('a'.repeat(6901), REVIEW_ORIGIN) },
  {
    name: 'typed metadata 30 lines',
    request: SignatureRequestSchema.parse({
      ...typedRequest(
        metadata,
        'Q428d047198445023e32a2C714759c1e779c29D13073B476607013d9ECBF131B785237125693f9B634fFf922Ac3f5ED44A1bfD3090b4d378502c67fe9bde6E732',
      ),
      origin: { ...REVIEW_ORIGIN, name: 'D'.repeat(17), url: urlPrefix + 'u'.repeat(63) },
    }),
  },
  {
    name: 'typed address rows',
    request: reviewRequest(withReviewDomain(payloadWith('address[]', RECIPIENTS))),
  },
  { name: 'typed short', request: typedRequest(payloadWith()) },
];
