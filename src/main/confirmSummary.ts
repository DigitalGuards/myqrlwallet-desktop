/**
 * The text the trusted confirmation window shows, computed as a pure function
 * of the validated signature request and of what main remembers about building
 * it.
 *
 * This lives apart from `confirm.ts` deliberately: `confirm.ts` imports
 * Electron to draw the dialog, while WHAT the user is asked to approve is the
 * security-relevant part and must be testable on its own.
 *
 * The transaction itself is renderer-supplied, so this module states the
 * numbers that will be signed and says where they came from. Main's own build
 * record is the only wallet-computed input here; when one is missing, the
 * summary says so plainly.
 */
import type { DAppOrigin, SignatureRequest } from '../shared/schemas';
import type { GasBuildRecord } from './buildRecords';
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
 * How far above the wallet's own estimate a dApp-requested gas limit may go
 * before the dialog warns about it: four times the estimate, or the estimate
 * plus a flat million gas, whichever is higher.
 *
 * The flat term keeps ordinary settlement headroom quiet. QuantaSwap's HTLCv3
 * claim asks for `estimateGas + 250000`, which stays inside the allowance at
 * every realistic estimate size. The multiplicative term catches a large
 * request on a large estimate, where a flat million would be noise.
 */
export function gasWarningThreshold(estimated: bigint): bigint {
  const multiplied = estimated * 4n;
  const flat = estimated + 1_000_000n;
  return multiplied > flat ? multiplied : flat;
}

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

/** The gas-limit row plus any provenance or warning lines that belong with it. */
function gasLines(gas: string, build: GasBuildRecord | undefined): string[] {
  if (!build) {
    return [
      row('Gas limit:', gas),
      'NOTE: the fee fields were not assembled by this wallet, so it cannot say',
      '      how this gas limit was chosen.',
    ];
  }
  if (build.requestedGas === undefined) {
    return [row('Gas limit:', `${gas} (this wallet's estimate)`)];
  }
  const requested = BigInt(build.requestedGas);
  const estimated = BigInt(build.estimatedGas);
  const lines = [
    row('Gas limit:', `${gas} (set by the dApp; wallet estimate ${build.estimatedGas})`),
  ];
  if (requested > gasWarningThreshold(estimated)) {
    lines.push(
      'WARNING: the dApp asked for far more gas than this wallet estimated. The',
      '         unused part is refunded, so the cost below is the worst case.',
      '         Approve only if you know why this call needs that much.',
    );
  }
  return lines;
}

/**
 * Compute the confirm-window text for a signature request.
 *
 * `build` is what main remembers about assembling this exact transaction, and
 * it is what lets the gas row name its own source. For a transaction the fee
 * block is derived from the gas limit that is in the transaction, which may be
 * a dApp-requested limit the builder honoured over its own estimate (see
 * `resolveGasLimit` in rpc.ts). The user therefore sees the worst case they
 * are approving:
 *   max fee  = gas limit * maxFeePerGas
 *   max cost = amount + max fee
 * and the max cost is repeated in the dialog's prominent message line, because
 * for a zero-value contract call the fee IS the whole cost.
 */
export function summariseSignatureRequest(
  req: SignatureRequest,
  build?: GasBuildRecord,
): ConfirmSummary {
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
        ...gasLines(tx.gas, build),
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
        message: `Send ${formatQuanta(tx.value)}? Max cost ${formatQuanta(maxCost)}.`,
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
