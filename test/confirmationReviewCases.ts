import type { ConfirmContext } from '../src/main/confirmSummary';
import { SignatureRequestSchema, type SignatureRequest } from '../src/shared/schemas';
import { payloadWith, SIGNER } from './typedDataFixtures';
import {
  reviewCases,
  reviewRequest,
  REVIEW_ORIGIN,
  withReviewDomain,
} from './typedDataReviewFixtures';
import {
  messageRequest,
  DIALOG_CHROME_MESSAGE,
  GTK_WRAP_MESSAGE,
  QUANTASWAP_MESSAGE,
} from './messageReviewFixtures';

export interface ConfirmationReviewCase {
  name: string;
  request: SignatureRequest;
  context: ConfirmContext;
}

/** The review-round-one corpus, plus acceptance and escape boundaries. */
export function confirmationReviewCases(): ConfirmationReviewCase[] {
  const cases: ConfirmationReviewCase[] = [];
  const add = (name: string, request: SignatureRequest, context: ConfirmContext = {}) => {
    cases.push({ name, request, context });
  };
  for (const fixture of reviewCases) {
    add(fixture.label, reviewRequest(fixture.payload), { connectedChainId: 3151909 });
  }
  for (const n of [0, 1, 40, 45, 46, 47, 60, 62, 63, 64, 65, 80, 100, 1000, 5000, 16000]) {
    for (const token of ['a', 'MW#', '漢字', '\\"\n', '😀', '\u202e']) {
      const value = token.repeat(n);
      if (Buffer.byteLength(value) > 16384) continue;
      for (const origin of [undefined, REVIEW_ORIGIN]) {
        add(
          `message ${n} ${JSON.stringify(token)} ${Boolean(origin)}`,
          messageRequest(value, origin),
        );
      }
    }
    for (const type of ['string', 'bytes']) {
      const value = type === 'string' ? 'x'.repeat(n) : '0x' + 'ab'.repeat(n);
      for (const origin of [undefined, REVIEW_ORIGIN]) {
        const parsed = SignatureRequestSchema.safeParse({
          kind: 'typedData',
          signer: SIGNER,
          payload: withReviewDomain(payloadWith(type, value)),
          ...(origin ? { origin } : {}),
        });
        if (parsed.success)
          add(`typed ${type} ${n} ${Boolean(origin)}`, parsed.data, { connectedChainId: 3151909 });
      }
    }
  }
  for (const [name, text] of Object.entries({
    DIALOG_CHROME_MESSAGE,
    GTK_WRAP_MESSAGE,
    QUANTASWAP_MESSAGE,
  })) {
    add(name, messageRequest(text, REVIEW_ORIGIN));
  }
  for (const n of [1, 8, 18, 40, 80])
    for (const feeLen of [1, 18, 40, 80]) {
      for (const [originIndex, origin] of [
        undefined,
        REVIEW_ORIGIN,
        { ...REVIEW_ORIGIN, name: 'MW'.repeat(64), url: 'https://example.org/' + 'a'.repeat(200) },
      ].entries()) {
        const contexts: ConfirmContext[] = [
          {},
          { build: { estimatedGas: '21000' } },
          { build: { estimatedGas: '21000', requestedGas: '2000000' } },
          { build: { estimatedGas: '2000000', requestedGas: '21000' } },
          { build: { estimatedGas: '3000000', requestedGas: '21000' } },
          { blockGasLimit: 1000000n },
        ];
        for (const [contextIndex, context] of contexts.entries()) {
          const parsed = SignatureRequestSchema.safeParse({
            kind: 'transaction',
            ...(origin ? { origin } : {}),
            tx: {
              type: '0x2',
              from: SIGNER,
              to: SIGNER,
              value: '9'.repeat(n),
              nonce: 42,
              gas: '2000000',
              maxFeePerGas: '9'.repeat(feeLen),
              maxPriorityFeePerGas: '1',
              chainId: 3151909,
              data: '0x' + 'ab'.repeat(40),
            },
          });
          if (parsed.success)
            add(`transaction ${n} ${feeLen} ${originIndex} ${contextIndex}`, parsed.data, context);
        }
      }
    }
  add(
    'typed preview sentinel',
    reviewRequest(withReviewDomain(payloadWith('string', 'A'.repeat(44) + 'B' + 'C'.repeat(55)))),
  );
  for (const token of ['\\"\n', '😀', '\u200b', '{{count}}']) {
    add(
      `typed escaped preview ${JSON.stringify(token)}`,
      reviewRequest(withReviewDomain(payloadWith('string', token.repeat(40)))),
    );
  }
  for (const n of [1, 50, 100, 150, 160, 161, 200, 256]) {
    add(
      `typed array ${n}`,
      reviewRequest(
        withReviewDomain(
          payloadWith(
            'uint8[]',
            Array.from({ length: n }, () => 1),
          ),
        ),
      ),
    );
  }
  for (const n of [40, 80, 120, 250]) {
    const payload = withReviewDomain(payloadWith());
    payload.domain['name'] = 'n'.repeat(n);
    add(`typed metadata ${n}`, reviewRequest(payload));
  }
  for (const n of [1840, 1841, 3450, 3451, 4140, 4141, 5000, 6900, 6901]) {
    add(`message boundary ${n}`, messageRequest('a'.repeat(n), REVIEW_ORIGIN));
    add(`binary boundary ${n}`, messageRequest(new Uint8Array(n).fill(0xff), REVIEW_ORIGIN));
  }
  for (const n of [4600, 4601, 9200, 9201]) {
    add(`message without origin ${n}`, messageRequest('a'.repeat(n)));
    add(`binary without origin ${n}`, messageRequest(new Uint8Array(n).fill(0xff)));
  }
  const urlPrefix = 'https://example.org/';
  add(
    'transaction invisible URL',
    SignatureRequestSchema.parse({
      kind: 'transaction',
      origin: { ...REVIEW_ORIGIN, url: urlPrefix + '\u200b'.repeat(256 - urlPrefix.length) },
      tx: {
        type: '0x2',
        from: SIGNER,
        to: SIGNER,
        value: '1',
        nonce: 0,
        gas: '21000',
        maxFeePerGas: '1',
        maxPriorityFeePerGas: '1',
        chainId: 3151909,
      },
    }),
  );
  return cases;
}
