import type { TypedDataPayload } from '../src/shared/typedData';
import { SignatureRequestSchema } from '../src/shared/schemas';
import { canonical, payloadWith, SIGNER } from './typedDataFixtures';

export const REVIEW_ORIGIN = {
  via: 'dapp',
  name: 'QRL Connect Test dApp',
  url: 'https://dapp.example/',
  channelId: '12345678-abcd-1234-abcd-123456789012',
} as const;
export const REVIEW_CONTRACT = `Q${'c0'.repeat(64)}`;
export const ATTACKER_SPENDER = `Q${'bb'.repeat(64)}`;
export const UNLIMITED = (2n ** 256n - 1n).toString();

export function withReviewDomain(payload: TypedDataPayload): TypedDataPayload {
  return {
    ...payload,
    types: {
      ...payload.types,
      QRLDomain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
    domain: {
      name: 'Quanta Token',
      version: '1',
      chainId: 3151909,
      verifyingContract: REVIEW_CONTRACT,
    },
  };
}

export function permitPayload(value = '1000000000000000000000'): TypedDataPayload {
  return withReviewDomain({
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: {},
    message: { owner: SIGNER, spender: ATTACKER_SPENDER, value, nonce: 0, deadline: UNLIMITED },
  });
}

export function reviewRequest(payload: TypedDataPayload) {
  return SignatureRequestSchema.parse({
    kind: 'typedData',
    payload,
    signer: SIGNER,
    origin: REVIEW_ORIGIN,
  });
}

export const RECIPIENTS = Array.from(
  { length: 12 },
  (_, i) => `Q${(i + 1).toString(16).padStart(128, '0')}`,
);
const noteFields = Array.from({ length: 25 }, (_, i) => ({ name: `note${i}`, type: 'string' }));

export const reviewCases: { label: string; payload: TypedDataPayload; paths: string[] }[] = [
  ...canonical.schemeVectors.map(({ payload }) => {
    const pathsByType: Record<string, string[]> = {
      StakeIntent: ['staker', 'qrlAmount', 'minShares', 'referrer', 'nonce', 'deadline'],
      Batch: [
        'payer.addr',
        'payer.memo',
        'recipients[0]',
        'recipients[1]',
        'recipients[2]',
        'deltas[0]',
        'deltas[1]',
        'cap',
        'small',
        'flag',
        'ref',
        'tag',
        'note',
      ],
      Ping: ['count'],
      Vote: ['proposal', 'support', 'weight', 'reason'],
    };
    const paths = pathsByType[payload.primaryType];
    if (!paths) throw new Error('missing canonical review paths');
    return { label: payload.primaryType, payload, paths: paths.map((path) => `message.${path}`) };
  }),
  {
    label: 'Permit',
    payload: permitPayload(),
    paths: ['owner', 'spender', 'value', 'nonce', 'deadline'].map((p) => `message.${p}`),
  },
  {
    label: 'Order',
    payload: withReviewDomain({
      types: {
        Order: [
          { name: 'maker', type: 'address' },
          { name: 'makerAsset', type: 'address' },
          { name: 'takerAsset', type: 'address' },
          { name: 'makerAmount', type: 'uint256' },
          { name: 'takerAmount', type: 'uint256' },
          { name: 'expiry', type: 'uint64' },
        ],
      },
      primaryType: 'Order',
      domain: {},
      message: {
        maker: SIGNER,
        makerAsset: `Q${'11'.repeat(64)}`,
        takerAsset: `Q${'22'.repeat(64)}`,
        makerAmount: '1000',
        takerAmount: '2000',
        expiry: 1760000000,
      },
    }),
    paths: ['maker', 'makerAsset', 'takerAsset', 'makerAmount', 'takerAmount', 'expiry'].map(
      (p) => `message.${p}`,
    ),
  },
  {
    label: 'Mail',
    payload: withReviewDomain({
      types: {
        Person: [
          { name: 'name', type: 'string' },
          { name: 'wallet', type: 'address' },
        ],
        Mail: [
          { name: 'from', type: 'Person' },
          { name: 'to', type: 'Person' },
          { name: 'contents', type: 'string' },
        ],
      },
      primaryType: 'Mail',
      domain: {},
      message: {
        from: { name: 'Cow', wallet: SIGNER },
        to: { name: 'Bob', wallet: ATTACKER_SPENDER },
        contents: 'Hello, Bob!',
      },
    }),
    paths: ['from.name', 'from.wallet', 'to.name', 'to.wallet', 'contents'].map(
      (p) => `message.${p}`,
    ),
  },
  {
    label: '12 addresses',
    payload: withReviewDomain(payloadWith('address[]', RECIPIENTS)),
    paths: RECIPIENTS.map((_, i) => `message.value[${i}]`),
  },
  {
    label: '25 long strings',
    payload: withReviewDomain({
      types: { Notes: noteFields },
      primaryType: 'Notes',
      domain: {},
      message: Object.fromEntries(noteFields.map(({ name }) => [name, 'a'.repeat(1000)])),
    }),
    paths: noteFields.map(({ name }) => `message.${name}`),
  },
];
