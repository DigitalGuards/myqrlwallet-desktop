/**
 * In-window settings panel policy (src/main/settingsViewPolicy.ts): the
 * security-relevant decisions of the WebContentsView that main stacks over the
 * wallet renderer.
 *
 * Verified here:
 *   - the panel refuses to open while the lock screen owns the display, ahead
 *     of every other consideration, so it can never be attached to (or reveal)
 *     the hidden wallet window
 *   - a second open request focuses the live panel and builds no second one
 *   - the panel never opens without a wallet window to host it
 *   - an approved remove-wallet confirmation is abandoned when the panel was
 *     torn down mid-dialog (lock takeover, qrlconnect:// delivery, dApp
 *     attention request), so no settings action survives its surface
 *   - closing never hands focus back to a hidden or locked wallet window
 *   - the panel is laid out over the whole window content area, clamping
 *     degenerate sizes so a resize handler never throws
 *
 * Pure functions with no Electron import, so this runs under
 * `node --test --import tsx`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRemovalStillAuthorized,
  resolveOpenAction,
  settingsViewBounds,
  shouldRestoreWalletFocus,
} from '../src/main/settingsViewPolicy';

test('open refuses while the lock screen owns the display', () => {
  assert.equal(
    resolveOpenAction({ locked: true, hasWalletWindow: true, hasLiveView: false }),
    'refuse-locked',
  );
  // The lock check wins over every other state, including an already-open
  // panel (the lock hook tears it down) and a missing wallet window.
  assert.equal(
    resolveOpenAction({ locked: true, hasWalletWindow: true, hasLiveView: true }),
    'refuse-locked',
  );
  assert.equal(
    resolveOpenAction({ locked: true, hasWalletWindow: false, hasLiveView: false }),
    'refuse-locked',
  );
});

test('open needs a wallet window to host the panel', () => {
  assert.equal(
    resolveOpenAction({ locked: false, hasWalletWindow: false, hasLiveView: false }),
    'refuse-no-window',
  );
});

test('a second open request focuses the live panel, a first one creates it', () => {
  assert.equal(
    resolveOpenAction({ locked: false, hasWalletWindow: true, hasLiveView: true }),
    'focus-existing',
  );
  assert.equal(
    resolveOpenAction({ locked: false, hasWalletWindow: true, hasLiveView: false }),
    'create',
  );
});

test('a declined removal is never authorized', () => {
  assert.equal(
    isRemovalStillAuthorized({ approved: false, viewIsCurrent: true, locked: false }),
    false,
  );
});

test('an approved removal proceeds only while its panel is still the live one', () => {
  assert.equal(
    isRemovalStillAuthorized({ approved: true, viewIsCurrent: true, locked: false }),
    true,
  );
  // Panel torn down mid-dialog: a qrlconnect:// delivery or a dApp attention
  // request closed it, so the approval no longer belongs to a live surface.
  assert.equal(
    isRemovalStillAuthorized({ approved: true, viewIsCurrent: false, locked: false }),
    false,
  );
});

test('an approved removal is abandoned when the lock screen took over', () => {
  assert.equal(
    isRemovalStillAuthorized({ approved: true, viewIsCurrent: true, locked: true }),
    false,
  );
  assert.equal(
    isRemovalStillAuthorized({ approved: true, viewIsCurrent: false, locked: true }),
    false,
  );
});

test('closing restores wallet focus only to a visible, unlocked window', () => {
  assert.equal(shouldRestoreWalletFocus({ locked: false, windowVisible: true }), true);
  // Hidden by the lock screen: focusing it could raise it on some platforms.
  assert.equal(shouldRestoreWalletFocus({ locked: true, windowVisible: false }), false);
  assert.equal(shouldRestoreWalletFocus({ locked: true, windowVisible: true }), false);
  assert.equal(shouldRestoreWalletFocus({ locked: false, windowVisible: false }), false);
});

test('the panel covers the whole content area and clamps degenerate sizes', () => {
  assert.deepEqual(settingsViewBounds(1100, 800), { x: 0, y: 0, width: 1100, height: 800 });
  assert.deepEqual(settingsViewBounds(1100.6, 800.4), { x: 0, y: 0, width: 1100, height: 800 });
  assert.deepEqual(settingsViewBounds(0, 0), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(settingsViewBounds(-10, 800), { x: 0, y: 0, width: 0, height: 800 });
  assert.deepEqual(settingsViewBounds(Number.NaN, 800), { x: 0, y: 0, width: 0, height: 800 });
});
