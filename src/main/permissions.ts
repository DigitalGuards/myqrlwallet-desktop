/**
 * Renderer permission policy: deny every web permission except clipboard write.
 *
 * Electron AUTO-GRANTS any permission when no handler is installed, and Chromium
 * keeps widening the set of device/media APIs reachable by default (camera, mic,
 * geolocation, notifications, WebUSB/HID/Serial/Bluetooth, the `fileSystem`
 * permission added in Electron 42). For a wallet, deny-by-default is the only
 * durable containment: even an in-origin renderer compromise then hits a closed
 * gate instead of a silently-granted camera, mic, or device picker.
 *
 * Kept in its own module with a TYPE-ONLY Electron import so the policy is unit
 * testable under `node --test` without loading the Electron runtime (importing
 * the real `electron` module from a plain Node ESM context throws).
 */
import type { Session } from 'electron';

/**
 * The single web permission the renderer legitimately needs: clipboard WRITE,
 * used by "copy address" (`navigator.clipboard.write` / `writeText`). Reading
 * the clipboard is NOT needed (the PIN paste path uses the synchronous paste
 * event, which is ungated), so `clipboard-read` is intentionally excluded.
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * Install deny-by-default permission handlers on `session`. Only clipboard write
 * is allowed; everything else, including every device-selection prompt, is
 * refused. One install covers every window that shares the session.
 */
export function installPermissionHandlers(session: Session): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
  // No WebUSB / HID / Serial / Bluetooth device this wallet talks to: refuse
  // every device-selection prompt outright.
  session.setDevicePermissionHandler(() => false);
}
