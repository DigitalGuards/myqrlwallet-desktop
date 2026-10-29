import typed from './fixtures/quantaVault/typed-data-v2.json';
import approvals from './fixtures/quantaVault/vault-approvals.json';
import calls from './fixtures/quantaVault/calldata.json';
import { TypedDataPayloadSchema } from '../src/shared/schemas';

export const vaultTestAddress = `Q${'ab'.repeat(64)}`;
export const vaultSchemeVectors = [...typed.schemeVectors, ...approvals.schemeVectors];

export function vaultPayload(label = 'empty-call') {
  const fixture = vaultSchemeVectors.find((vector) => vector.label === label);
  if (!fixture) throw new Error(`Missing vault fixture: ${label}`);
  return TypedDataPayloadSchema.parse(structuredClone(fixture.payload));
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
