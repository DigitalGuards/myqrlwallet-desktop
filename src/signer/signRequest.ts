/** Session-bound signing shared by the utility-process entrypoint and tests. */
import type { SignatureRequest, SignatureResult } from '../shared/schemas';
import type { SignerSession } from './session';
import { assertSessionSigner, signMessage, signTransaction, signTypedData } from './signing';

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
    case 'typedData':
      return session.withSeed((seed) => signTypedData(seed, request.payload), now);
  }
}
