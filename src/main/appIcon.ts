/**
 * Window icon for the app-owned windows (wallet, unlock, settings).
 *
 * Windows takes its window/taskbar icon from the signed executable's embedded
 * resource (build/icon.ico) and macOS from the bundle, so only Linux needs an
 * explicit `icon` on the BrowserWindow: an AppImage has no installed .desktop
 * entry for the WM to match against, and without this the shell falls back to
 * a generic icon.
 *
 * `?asset` makes electron-vite emit the PNG next to the main bundle and hand
 * back its runtime path, so the file resolves identically in dev and from
 * inside the packaged asar. It is a static, app-owned image: no network load
 * and no renderer involvement.
 */
import { platform } from 'node:process';
import appIconPng from '../../build/icons/256x256.png?asset';

/** Spread into BrowserWindow options: `{ icon }` on Linux, empty elsewhere. */
export const windowIcon: { icon?: string } = platform === 'linux' ? { icon: appIconPng } : {};
