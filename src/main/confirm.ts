/**
 * Transaction-confirmation modal, drawn by the MAIN process in a trusted,
 * OS-native context (`dialog.showMessageBox`). This is deliberately NOT
 * rendered by the renderer: a compromised renderer must not be able to spoof
 * "what is being signed". The user authorises the exact summary main computed
 * from the validated request, and only then does main ask the signer to sign.
 */
import { type BrowserWindow, dialog } from 'electron';
import type { DAppOrigin, SignatureRequest } from '../shared/schemas';

/** Format a smallest-unit integer string as QUANTA (18 decimals), trimmed. */
function formatQuanta(smallestUnit: string): string {
  const v = BigInt(smallestUnit);
  const DECIMALS = 18n;
  const base = 10n ** DECIMALS;
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return `${whole.toString()} QUANTA`;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr} QUANTA`;
}

/**
 * Render the dApp provenance block for a request that arrived over a
 * dApp-connect session. The values are renderer-supplied (ultimately from the
 * dApp's ORIGINATOR_INFO), so they are labelled unverified: they tell the
 * user WHO CLAIMS to be asking, while the amounts/addresses above remain
 * main-computed facts. Schema-bounded upstream (length caps, no control
 * chars), so they are safe to render verbatim.
 */
function originDetail(origin: DAppOrigin | undefined): string {
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

function summarise(req: SignatureRequest): { title: string; message: string; detail: string } {
  switch (req.kind) {
    case 'transaction': {
      const { tx } = req;
      const detail = [
        `Amount:   ${formatQuanta(tx.value)}`,
        `To:       ${tx.to}`,
        `From:     ${tx.from}`,
        `Nonce:    ${tx.nonce}`,
        `Gas:      ${tx.gas}`,
        `Max fee:  ${tx.maxFeePerGas} (priority ${tx.maxPriorityFeePerGas})`,
        `Chain id: ${tx.chainId}`,
        tx.data && tx.data !== '0x' ? `Data:     ${tx.data.slice(0, 66)}…` : 'Data:     (none)',
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
        detail:
          `Message (hex):\n${req.messageHex.slice(0, 256)}${req.messageHex.length > 256 ? '…' : ''}` +
          originDetail(req.origin),
      };
    case 'typedData':
      return {
        title: 'Confirm typed-data signature',
        message: 'Sign this structured data with your wallet key?',
        detail: `Payload keys: ${Object.keys(req.payload).join(', ')}` + originDetail(req.origin),
      };
  }
}

/**
 * Show the modal confirmation and return whether the user approved. The dialog
 * is parented to (and modal over) the wallet window so it cannot be ignored.
 */
export async function confirmSignature(
  parent: BrowserWindow,
  req: SignatureRequest,
): Promise<boolean> {
  const { title, message, detail } = summarise(req);
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['Approve & sign', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title,
    message,
    detail: `${detail}\n\nApprove only if you initiated this and the details are correct.`,
    noLink: true,
  });
  return response === 0;
}

/**
 * Trusted, main-drawn confirmation for the destructive wallet wipe. Like
 * {@link confirmSignature}, this is deliberately NOT rendered by the renderer:
 * removing the wallet irreversibly deletes the encrypted seed and is reachable
 * from the renderer, so a compromised renderer must not be able to trigger it
 * unprompted. The dialog defaults to Cancel.
 */
export async function confirmRemoveWallet(
  parent: BrowserWindow,
  address: string,
): Promise<boolean> {
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['Remove wallet', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Remove wallet from this device?',
    message: 'Permanently remove this wallet from this device?',
    detail:
      `Account: ${address}\n\n` +
      'The encrypted seed will be deleted from this device. You can restore the wallet only with your recovery phrase. This cannot be undone.',
    noLink: true,
  });
  return response === 0;
}
