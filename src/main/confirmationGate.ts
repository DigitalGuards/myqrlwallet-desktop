import { setTimeout as delay } from 'node:timers/promises';
import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';

export const ARM_DELAY_MS = 1000;

export interface ConfirmationClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/** One main-owned slot and clock for signature and wallet-removal dialogs. */
export class ConfirmationGate {
  private active: AbortController | undefined;
  private lastClosedAt = -Infinity;
  private requestNumber = 0;

  constructor(
    private readonly clock: ConfirmationClock = {
      now: () => performance.now(),
      wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
    },
  ) {}

  abort(reason: Error): void {
    this.active?.abort(reason);
  }

  private async waitToArm(signal: AbortSignal): Promise<void> {
    let remaining = ARM_DELAY_MS - (this.clock.now() - this.lastClosedAt);
    while (remaining > 0) {
      try {
        await this.clock.wait(remaining, signal);
      } finally {
        // Preserve the visible failure reason when the timer is aborted.
        signal.throwIfAborted();
      }
      remaining = ARM_DELAY_MS - (this.clock.now() - this.lastClosedAt);
    }
  }

  async show(
    parent: BrowserWindow,
    pages: MessageBoxOptions[],
    approvalId: number,
  ): Promise<boolean> {
    if (this.active) throw new Error('another confirmation is already open');
    this.lastClosedAt = Math.max(this.lastClosedAt, this.clock.now());
    const controller = new AbortController();
    const { signal } = controller;
    const requestNumber = ++this.requestNumber;
    let webContents: BrowserWindow['webContents'] | undefined;
    const navigated = () => {
      controller.abort(
        new Error('Wallet window reloaded or navigated during confirmation. Please try again.'),
      );
    };
    const navigationStarted = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument) navigated();
    };
    const rendererGone = () => {
      controller.abort(new Error('Wallet renderer stopped during confirmation. Please try again.'));
    };
    try {
      this.active = controller;
      webContents = parent.webContents;
      webContents.on('did-start-navigation', navigationStarted);
      webContents.on('did-navigate', navigated);
      webContents.on('render-process-gone', rendererGone);
      parent.on('closed', rendererGone);
      for (const [index, options] of pages.entries()) {
        await this.waitToArm(signal);
        signal.throwIfAborted();
        let response: number;
        try {
          ({ response } = await dialog.showMessageBox(parent, {
            ...options,
            message:
              `Request ${requestNumber}` +
              (pages.length > 1 ? `, page ${index + 1} of ${pages.length}` : '') +
              `\n${options.message}`,
            signal,
          }));
        } finally {
          // Cancellation, abort and native errors all start the same arming delay.
          this.lastClosedAt = this.clock.now();
        }
        // An aborted native dialog may resolve with a racing approval response.
        signal.throwIfAborted();
        if (response !== (index === pages.length - 1 ? approvalId : 0)) return false;
      }
      return true;
    } finally {
      this.active = undefined;
      webContents?.off('did-start-navigation', navigationStarted);
      webContents?.off('did-navigate', navigated);
      webContents?.off('render-process-gone', rendererGone);
      parent.off('closed', rendererGone);
    }
  }
}

export const confirmationGate = new ConfirmationGate();
