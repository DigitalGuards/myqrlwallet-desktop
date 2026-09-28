/**
 * Transaction-confirmation modal, drawn by the MAIN process in a trusted,
 * OS-native context (`dialog.showMessageBox`). This is deliberately NOT
 * rendered by the renderer: a compromised renderer must not be able to spoof
 * "what is being signed". The user authorises the exact summary main computed
 * from the validated request, and only then does main ask the signer to sign.
 */
import { type BrowserWindow, dialog } from 'electron';
import type { SignatureRequest } from '../shared/schemas';
import { groupQrlAddress } from '../shared/address';
import { type ConfirmContext, summariseSignatureRequest } from './confirmSummary';

/**
 * Show the modal confirmation and return whether the user approved. The dialog
 * is parented to (and modal over) the wallet window so it cannot be ignored.
 *
 * `context` carries main's record of building this exact transaction, which
 * lets the dialog say whether the gas limit is the wallet's own estimate, a
 * dApp-requested one or the block ceiling, plus the block gas limit an
 * unattributed limit is measured against. With no record the dialog states
 * plainly that the fee fields were not assembled by this wallet.
 */
export async function confirmSignature(
  parent: BrowserWindow,
  req: SignatureRequest,
  context: ConfirmContext = {},
): Promise<boolean> {
  const { title, message, detail } = summariseSignatureRequest(req, context);
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
      `Account: ${groupQrlAddress(address)}\n\n` +
      'The encrypted seed will be deleted from this device. You can restore the wallet only with your recovery phrase. This cannot be undone.',
    noLink: true,
  });
  return response === 0;
}
