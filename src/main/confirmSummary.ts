/**
 * The text the trusted confirmation window shows, computed as a pure function
 * of the validated signature request.
 *
 * This lives apart from `confirm.ts` deliberately: `confirm.ts` imports
 * Electron to draw the dialog, while WHAT the user is asked to approve is the
 * security-relevant part and must be testable on its own. Everything here is
 * derived from the request main already validated and assembled, so the
 * summary cannot disagree with the bytes the signer will sign.
 */
import type { DAppOrigin, SignatureRequest } from '../shared/schemas';
import { groupQrlAddress } from '../shared/address';

const DECIMALS = 18n;

/** Format a smallest-unit integer string as Quanta (18 decimals), trimmed. */
export function formatQuanta(smallestUnit: string | bigint): string {
  const v = typeof smallestUnit === 'bigint' ? smallestUnit : BigInt(smallestUnit);
  const base = 10n ** DECIMALS;
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return `${whole.toString()} Quanta`;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr} Quanta`;
}

/** Label column width, so every detail line stays aligned in the dialog. */
const LABEL_WIDTH = 11;
const row = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}${value}`;

/**
 * Render the dApp provenance block for a request that arrived over a
 * dApp-connect session. The values are renderer-supplied (ultimately from the
 * dApp's ORIGINATOR_INFO), so they are labelled unverified: they tell the
 * user WHO CLAIMS to be asking, while the amounts/addresses above remain
 * main-computed facts. Schema-bounded upstream (length caps, no control
 * chars), so they are safe to render verbatim.
 */
export function originDetail(origin: DAppOrigin | undefined): string {
  if (!origin) return '';
  return [
    '',
    'Requested by dApp (unverified, dApp-supplied):',
    `  Name:    ${origin.name}`,
    `  URL:     ${origin.url || '(not provided)'}`,
    `  Channel: ${origin.channelId}`,
    'Only approve if you initiated this action in that dApp.',
  ].join('\n');
}

export interface ConfirmSummary {
  title: string;
  message: string;
  detail: string;
}

/**
 * Compute the confirm-window text for a signature request.
 *
 * For a transaction the fee block is derived from the gas limit that is
 * actually in the transaction, which may be a dApp-requested limit the builder
 * honoured over its own estimate (see `resolveGasLimit` in rpc.ts). The
 * user therefore sees the worst case they are approving:
 *   max fee  = gas limit * maxFeePerGas
 *   max cost = amount + max fee
 */
export function summariseSignatureRequest(req: SignatureRequest): ConfirmSummary {
  switch (req.kind) {
    case 'transaction': {
      const { tx } = req;
      const maxFee = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
      const maxCost = BigInt(tx.value) + maxFee;
      const detail = [
        row('Amount:', formatQuanta(tx.value)),
        row('To:', groupQrlAddress(tx.to)),
        row('From:', groupQrlAddress(tx.from)),
        row('Nonce:', String(tx.nonce)),
        row('Gas limit:', tx.gas),
        row(
          'Max fee:',
          `${formatQuanta(maxFee)} (up to ${tx.maxFeePerGas} per gas, priority ${tx.maxPriorityFeePerGas})`,
        ),
        row('Max cost:', formatQuanta(maxCost)),
        row('Chain id:', String(tx.chainId)),
        tx.data && tx.data !== '0x'
          ? row('Data:', `${tx.data.slice(0, 66)}…`)
          : row('Data:', '(none)'),
      ].join('\n');
      return {
        title: 'Confirm transaction',
        message: `Send ${formatQuanta(tx.value)}?`,
        detail: detail + originDetail(req.origin),
      };
    }
    case 'message':
      return {
        title: 'Confirm message signature',
        message: 'Sign this message with your wallet key?',
        // req.signer is trustworthy to display: main verified it against the
        // unlocked session before this modal, and the signer re-enforces it.
        detail:
          `${row('Account:', groupQrlAddress(req.signer))}\n` +
          `Message (hex):\n${req.messageHex.slice(0, 256)}${req.messageHex.length > 256 ? '…' : ''}` +
          originDetail(req.origin),
      };
    case 'typedData':
      return {
        title: 'Confirm typed-data signature',
        message: 'Sign this structured data with your wallet key?',
        detail:
          `${row('Account:', groupQrlAddress(req.signer))}\n` +
          `Payload keys: ${Object.keys(req.payload).join(', ')}` +
          originDetail(req.origin),
      };
  }
}
