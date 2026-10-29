import typed from './fixtures/quantaVault/typed-data-v2.json';
import approvals from './fixtures/quantaVault/vault-approvals.json';
import calls from './fixtures/quantaVault/calldata.json';
import review from './fixtures/quantaVault/review-cases.json';
import { isRecord } from '../src/shared/guards';
import { TypedDataPayloadSchema } from '../src/shared/schemas';

export const vaultTestAddress = `Q${'ab'.repeat(64)}`;
export const vaultSchemeVectors = [...typed.schemeVectors, ...approvals.schemeVectors];
export const vaultReviewVectors = review.cases;
export const vaultReviewTime = BigInt(review.reviewTime);

export function vaultPayload(label = 'empty-call') {
  const reviewCase = vaultReviewVectors.find((vector) => vector.label === label);
  const fixture = vaultSchemeVectors.find(
    (vector) => vector.label === (reviewCase?.baseLabel ?? label),
  );
  if (!fixture) throw new Error(`Missing vault fixture: ${label}`);
  const payload = TypedDataPayloadSchema.parse(structuredClone(fixture.payload));
  if (reviewCase) {
    const tx = payload.primaryType === 'VaultApproval' ? payload.message['tx'] : payload.message;
    if (!isRecord(tx)) throw new Error('Missing vault transaction');
    Object.assign(tx, reviewCase.tx);
  }
  return payload;
}

export function vaultCalldata(method: string) {
  const fixture = calls.find((vector) => vector.method === method);
  if (!fixture) throw new Error(`Missing call fixture: ${method}`);
  return fixture;
}

export const vaultWord = (value: bigint): string => value.toString(16).padStart(128, '0');

export function vaultBatchPayload(entries: number) {
  const payload = vaultPayload();
  const packed = Array.from(
    { length: entries },
    (_, index) =>
      `${index % 3 === 0 ? '01' : '00'}${vaultWord(BigInt(index + 1))}${vaultWord(BigInt(index))}${vaultWord(0n)}`,
  ).join('');
  payload.message['data'] =
    vaultCalldata('multiSend').selector +
    vaultWord(64n) +
    vaultWord(BigInt(packed.length / 2)) +
    packed.padEnd(Math.ceil(packed.length / 128) * 128, '0');
  payload.message['operation'] = 1;
  return payload;
}
