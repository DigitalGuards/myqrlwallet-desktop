/**
 * Renderer permission hardening. installPermissionHandlers wires deny-by-default
 * handlers onto a session; the ONLY allowed permission is clipboard write
 * (navigator.clipboard.write / writeText, used by "copy address"). The handlers
 * are pure (they never touch an Electron runtime value), so they run under
 * `node --test --import tsx` against a fake session that captures the callbacks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from 'electron';

import { installPermissionHandlers } from '../src/main/permissions';

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void;
type CheckHandler = (webContents: unknown, permission: string) => boolean;
type DeviceHandler = () => boolean;

/** A fake Session that records the three handlers installPermissionHandlers sets. */
function captureHandlers(): {
  session: Session;
  request: () => RequestHandler;
  check: () => CheckHandler;
  device: () => DeviceHandler;
} {
  let request: RequestHandler | undefined;
  let check: CheckHandler | undefined;
  let device: DeviceHandler | undefined;
  const session = {
    setPermissionRequestHandler(fn: RequestHandler) {
      request = fn;
    },
    setPermissionCheckHandler(fn: CheckHandler) {
      check = fn;
    },
    setDevicePermissionHandler(fn: DeviceHandler) {
      device = fn;
    },
  } as unknown as Session;
  return {
    session,
    request: () => {
      assert.ok(request, 'request handler installed');
      return request;
    },
    check: () => {
      assert.ok(check, 'check handler installed');
      return check;
    },
    device: () => {
      assert.ok(device, 'device handler installed');
      return device;
    },
  };
}

// Permissions a wallet must never silently grant. Electron auto-grants these
// when no handler is set, and Chromium keeps widening the default-reachable set.
const DENIED = [
  'media',
  'geolocation',
  'notifications',
  'midiSysex',
  'clipboard-read',
  'fileSystem',
  'openExternal',
  'pointerLock',
  'window-management',
];

test('permission request handler grants only clipboard write', () => {
  const h = captureHandlers();
  installPermissionHandlers(h.session);
  const request = h.request();
  const granted = (permission: string): boolean => {
    // Start true so a handler that never invokes the callback fails the assert.
    let result = true;
    request(null, permission, (g) => {
      result = g;
    });
    return result;
  };
  assert.equal(granted('clipboard-sanitized-write'), true);
  for (const permission of DENIED) {
    assert.equal(granted(permission), false, `request "${permission}" must be denied`);
  }
});

test('permission check handler grants only clipboard write', () => {
  const h = captureHandlers();
  installPermissionHandlers(h.session);
  const check = h.check();
  assert.equal(check(null, 'clipboard-sanitized-write'), true);
  for (const permission of DENIED) {
    assert.equal(check(null, permission), false, `check "${permission}" must be denied`);
  }
});

test('device permission handler denies every device picker', () => {
  const h = captureHandlers();
  installPermissionHandlers(h.session);
  assert.equal(h.device()(), false);
});
