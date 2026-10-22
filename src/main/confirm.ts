/**
 * Transaction-confirmation modal, drawn by the MAIN process in a trusted,
 * OS-native context (`dialog.showMessageBox`). This is deliberately NOT
 * rendered by the renderer: a compromised renderer must not be able to spoof
 * "what is being signed". The user authorises the exact summary main computed
 * from the validated request, and only then does main ask the signer to sign.
 */
import { getLanguage, t } from './language';
import { translator } from '../shared/i18n';
import type { BrowserWindow } from 'electron';
import type { SignatureRequest } from '../shared/schemas';
import { groupQrlAddress } from '../shared/address';
import { type ConfirmContext, summariseSignatureRequest, wrapDetailText } from './confirmSummary';
import { confirmationGate } from './confirmationGate';

/** Abort the open or arming confirmation when its signing session ends. */
export function abortPendingConfirms(): void {
  confirmationGate.abort(new Error(t('error.lockedConfirm')));
}

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
  const language = getLanguage();
  const t = translator(language);
  const { title, message, pages } = summariseSignatureRequest(req, context, language);
  return confirmationGate.show(
    parent,
    pages.map((detail, index) => ({
      type: 'warning',
      buttons:
        index === pages.length - 1
          ? [t('common.cancel'), t('confirm.approve')]
          : [t('common.next'), t('common.cancel')],
      defaultId: index === pages.length - 1 ? 0 : 1,
      cancelId: index === pages.length - 1 ? 0 : 1,
      title,
      message,
      detail: wrapDetailText(`${detail}\n\n${t('confirm.approvalNote')}`),
      noLink: true,
    })),
    1,
    language,
  );
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
  return confirmationGate.show(
    parent,
    [
      {
        type: 'warning',
        buttons: [t('remove.button'), t('common.cancel')],
        defaultId: 1,
        cancelId: 1,
        title: t('remove.title'),
        message: t('remove.question'),
        detail: wrapDetailText(
          `${t('confirm.account')} ${groupQrlAddress(address)}\n\n` + t('remove.warning'),
        ),
        noLink: true,
      },
    ],
    0,
    getLanguage(),
  );
}
