/** Session-bound signing shared by the utility-process entrypoint and tests. */
import type { SignatureRequest, SignatureResult } from '../shared/schemas';
import type { SignerSession } from './session';
import { typedDataSchemeVersion } from '../shared/typedData';
import { assertSessionSigner, signMessage, signTransaction, signTypedDataDigest } from './signing';
import { computeTypedDataDigest } from './typedData';

export async function signRequest(
  session: SignerSession,
  request: SignatureRequest,
  chainId: number,
  now: number,
): Promise<SignatureResult> {
  if (!session.unlocked) throw new Error('locked');
  assertSessionSigner(request, session.address ?? '');
  switch (request.kind) {
    case 'transaction':
      return session.withSeedAsync((seed) => signTransaction(seed, request.tx, chainId), now);
    case 'message':
      return session.withSeed((seed) => signMessage(seed, request.messageHex), now);
    case 'typedData': {
      const digest = computeTypedDataDigest(request.payload);
      const schemeVersion = typedDataSchemeVersion(request.payload);
      return session.withSeed((seed) => signTypedDataDigest(seed, digest, schemeVersion), now);
    }
  }
}
