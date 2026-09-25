/**
 * Pure decision helpers for the in-window settings view
 * (src/main/settingsView.ts). They carry the security-relevant rules of the
 * surface, so they live apart from the Electron plumbing and are unit-tested
 * directly (test/settingsViewPolicy.test.ts) without an Electron runtime.
 *
 * No Electron import belongs in this file.
 */

export interface SettingsViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The view covers the wallet window's whole content area, so its bounds are
 * the content size at the content origin. Negative or non-finite sizes (a
 * minimised window on some platforms reports 0 or garbage) clamp to 0, so the
 * view draws nothing and a resize handler never throws.
 */
export function settingsViewBounds(contentWidth: number, contentHeight: number): SettingsViewRect {
  const clamp = (value: number): number =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return { x: 0, y: 0, width: clamp(contentWidth), height: clamp(contentHeight) };
}

export type SettingsOpenAction = 'refuse-locked' | 'refuse-no-window' | 'focus-existing' | 'create';

/**
 * What an "open settings" request (menu entry, accelerator, or the
 * sender-gated renderer ask) resolves to.
 *
 * The lock check comes FIRST and is unconditional: while the lock screen owns
 * the display it is the only permitted surface, and attaching a view to the
 * hidden wallet window would put settings actions (autolock, wallet removal)
 * back within reach. The caller answers 'refuse-locked' by focusing the unlock
 * window and never by revealing the wallet window.
 */
export function resolveOpenAction(state: {
  locked: boolean;
  hasWalletWindow: boolean;
  hasLiveView: boolean;
}): SettingsOpenAction {
  if (state.locked) return 'refuse-locked';
  if (!state.hasWalletWindow) return 'refuse-no-window';
  if (state.hasLiveView) return 'focus-existing';
  return 'create';
}

/**
 * Whether an approved remove-wallet confirmation may still proceed.
 *
 * The trusted dialog is drawn by main and parented to the wallet window, so it
 * outlives the settings view that started the flow. Between the click and the
 * answer the view can be torn down by a lock takeover, a qrlconnect:// URI
 * delivery, or a dApp attention request. Approving then would let a settings
 * action land after its surface (and, while locked, the whole app) was taken
 * away, so a stale or locked state reads as a cancel and nothing is deleted.
 */
export function isRemovalStillAuthorized(state: {
  approved: boolean;
  viewIsCurrent: boolean;
  locked: boolean;
}): boolean {
  return state.approved && state.viewIsCurrent && !state.locked;
}

/**
 * Whether closing the settings view may hand keyboard focus back to the wallet
 * renderer. It may not while the lock screen owns the display or while the
 * wallet window is hidden: focusing a hidden window's web contents can raise
 * it on some platforms, which would break the single-surface lock screen.
 */
export function shouldRestoreWalletFocus(state: {
  locked: boolean;
  windowVisible: boolean;
}): boolean {
  return !state.locked && state.windowVisible;
}
