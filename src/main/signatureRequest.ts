/** The confirmation and signer handoff used by REQUEST_SIGNATURE. */
import type { SignatureRequest, SignatureResult } from '../shared/schemas';
import type { SignerBridge } from './signerBridge';
import type { ConfirmContext } from './confirmSummary';
import { EXPECTED_CHAIN_ID } from './config';
import { vaultApprovalBlocked } from '../shared/quantaVault';
import { recallBuild } from './buildRecords';
import * as rpc from './rpc';

interface SignatureDeps {
  signer: Pick<SignerBridge, 'status' | 'sign'>;
  confirm: (request: SignatureRequest, context: ConfirmContext) => Promise<boolean>;
}

/** The caller validates sender and schema before entering this flow. */
export async function signWithConfirmation(
  req: SignatureRequest,
  { signer, confirm }: SignatureDeps,
): Promise<SignatureResult> {
  // Application policy belongs to main. The signer retains generic structural
  // re-validation; even a replacement confirmation callback cannot bypass this.
  if (req.kind === 'typedData' && vaultApprovalBlocked(req.payload)) {
    throw new Error('QuantaVault refunds are unsupported. All refund fields must be zero.');
  }
  // Transactions bind to the chain id: resolve it BEFORE the modal (fail fast
  // when the node is unreachable) and require it to match the tx the user is
  // shown, so the value confirmed in the dialog is exactly the value signed.
  // Message and typed-data signing use the configured network identity for
  // display and stay offline. Their digests come entirely from the request.
  let signingChainId = EXPECTED_CHAIN_ID;
  let confirmContext: ConfirmContext = { connectedChainId: EXPECTED_CHAIN_ID };
  if (req.kind === 'transaction') {
    // The block gas limit is checked HERE, alongside the chain id, because
    // the renderer supplies the transaction it asks to have signed. The
    // build-path check bounds what main assembles; this one bounds every
    // signature, including a transaction the renderer put together itself.
    const [chainId, blockGasLimit] = await Promise.all([rpc.getChainId(), rpc.getBlockGasLimit()]);
    signingChainId = chainId;
    if (req.tx.chainId !== signingChainId) {
      throw new Error('transaction chain id does not match the node; rebuild the transaction');
    }
    if (BigInt(req.tx.gas) > blockGasLimit) {
      throw new Error(
        `transaction gas limit ${req.tx.gas} exceeds the block gas limit ${blockGasLimit.toString(10)}; rebuild the transaction`,
      );
    }
    // What main remembers about building this exact transaction, so the
    // trusted confirm can name the gas limit's source, plus the ceiling an
    // unattributed limit is measured against. A miss is safe: the dialog
    // then says the fee fields were not assembled by this wallet.
    const build = recallBuild(req.tx);
    confirmContext = { blockGasLimit, ...(build ? { build } : {}) };
  }
  // Fail fast when the request targets a different account than the
  // unlocked session, BEFORE drawing the modal: the signer enforces the
  // same binding authoritatively, but the user should not be asked to
  // approve something that cannot be signed. Also guarantees the account
  // shown in the trusted confirm is the account that will sign.
  const requestedSigner = req.kind === 'transaction' ? req.tx.from : req.signer;
  const st = await signer.status();
  if (requestedSigner.toLowerCase() !== st.address?.toLowerCase()) {
    throw new Error(
      'signing account mismatch: request targets a different account than the unlocked session',
    );
  }
  const approved = await confirm(req, confirmContext);
  if (!approved) throw new Error('user rejected signature');
  return signer.sign(req, signingChainId);
}
