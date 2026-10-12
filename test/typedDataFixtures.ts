import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SCHEME } from '../src/shared/constants';
import { SignatureRequestSchema, TypedDataPayloadSchema } from '../src/shared/schemas';
import type { TypedDataPayload } from '../src/shared/typedData';

const scheme = z.enum([SCHEME.TAG_TYPED, SCHEME.TAG_TYPED_V2]);
const fixtureSchema = z.object({
  schemeVectors: z.array(
    z.object({
      label: z.string(),
      schemeVersion: scheme,
      payload: TypedDataPayloadSchema,
      encodeTypeString: z.string(),
      typeHashHex: z.string(),
      domainHashHex: z.string(),
      messageHashHex: z.string(),
      digestHex: z.string(),
    }),
  ),
  schemeSigningVectors: z.array(
    z.object({
      label: z.string(),
      hexSeed: z.string(),
      payload: TypedDataPayloadSchema,
      schemeVersion: scheme,
      signature: z.string(),
      publicKey: z.string(),
      descriptor: z.string(),
      signer: z.string(),
      digest: z.string(),
    }),
  ),
  typedVectors: z.array(z.object({ payload: z.unknown() })),
});

const raw: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/canonical.json', import.meta.url), 'utf8'),
);
export const canonical = fixtureSchema.parse(raw);
export const SIGNER = `Q${'a'.repeat(128)}`;

export function payloadWith(type = 'uint8', value: unknown = 1): TypedDataPayload {
  return {
    types: {
      QRLDomain: [{ name: 'name', type: 'string' }],
      Payload: [{ name: 'value', type }],
    },
    primaryType: 'Payload',
    domain: { name: 'Test dApp' },
    message: { value },
  };
}

export function typedRequest(payload: unknown, signer = SIGNER) {
  return SignatureRequestSchema.parse({ kind: 'typedData', payload, signer });
}
