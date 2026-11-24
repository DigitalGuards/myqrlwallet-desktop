/**
 * The colour theme, owned by main. Modeled on src/main/language.ts, with one
 * difference: the unlock window paints before the wallet renderer exists, so
 * main stores the choice and is the source of truth (renderer contract: the
 * wallet reads `qrlWallet.theme`, picks with `setTheme`, follows
 * `onThemeChanged`).
 *
 * - DEFAULT_THEME is the one place the default lives. Nothing is written until
 *   the user chooses, so a later change of the default reaches everyone who
 *   never chose.
 * - The choice drives `nativeTheme.themeSource`, so `prefers-color-scheme` in
 *   every window and the OS-drawn dialogs, title bars and menus follow it.
 * - `system` resolves through `nativeTheme.shouldUseDarkColors` and follows
 *   the OS live through the `updated` event.
 *
 * Electron's nativeTheme is injected by src/main/index.ts (initTheme): this
 * module has no top-level electron import, so it loads under plain-Node tests
 * and the IPC mock loaders.
 */
import {
  THEME_ARGUMENT_PREFIX,
  THEME_BACKGROUND,
  type ResolvedTheme,
  type ThemePreference,
  type ThemeState,
} from '../shared/theme';
import { updateSettings } from './settingsFile';

/** The preference of a user who never chose. Never written to storage. */
export const DEFAULT_THEME: ThemePreference = 'dark';

/** The part of Electron's nativeTheme this module uses. */
export interface NativeThemeSource {
  themeSource: ThemePreference;
  readonly shouldUseDarkColors: boolean;
  on(event: 'updated', listener: () => void): unknown;
}

let native: NativeThemeSource | null = null;
let subscribed: NativeThemeSource | null = null;
let preference: ThemePreference = DEFAULT_THEME;
let published: ThemeState = { theme: DEFAULT_THEME, resolved: 'dark' };
const listeners = new Set<(state: ThemeState) => void>();

function resolve(next: ThemePreference): ResolvedTheme {
  if (next !== 'system') return next;
  // Without the OS reading (tests, or before initTheme) system stays dark.
  return native !== null && !native.shouldUseDarkColors ? 'light' : 'dark';
}

/** The current choice (or the default) and what it resolves to. */
export function getThemeState(): ThemeState {
  return { theme: preference, resolved: resolve(preference) };
}

let notifications = 0;
function notify(state: ThemeState): void {
  published = state;
  notifications += 1;
  for (const listener of listeners) listener(state);
}

/** Notify listeners when the pair actually changed: assigning themeSource
 * also fires `updated`, and an OS flip matters only while following it. */
function publish(): void {
  const next = getThemeState();
  if (next.theme === published.theme && next.resolved === published.resolved) return;
  notify(next);
}

/**
 * Start-up: adopt the stored choice (undefined when the user never chose, or
 * when the stored value was invalid) and hand it to nativeTheme. Called once,
 * before any window or dialog exists.
 */
export function initTheme(
  nativeTheme: NativeThemeSource,
  stored: ThemePreference | undefined,
): void {
  native = nativeTheme;
  preference = stored ?? DEFAULT_THEME;
  nativeTheme.themeSource = preference;
  published = getThemeState();
  if (subscribed !== nativeTheme) {
    nativeTheme.on('updated', () => {
      publish();
    });
    subscribed = nativeTheme;
  }
}

/** Apply a preference in memory (no storage write). */
export function applyTheme(next: ThemePreference): void {
  preference = next;
  if (native) native.themeSource = next;
  publish();
}

export function onThemeChanged(listener: (state: ThemeState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Serialize choices so a slower write cannot restore an older one.
let pending = Promise.resolve();
/** The user's choice from the wallet's Theme row: store it, then apply it.
 * Every successful choice reaches the listeners once, also when it equals the
 * current one: the renderer waits for that push (theme contract). */
export function setTheme(next: ThemePreference): Promise<void> {
  const result = pending.then(async () => {
    await updateSettings({ theme: next });
    const before = notifications;
    applyTheme(next);
    if (notifications === before) notify(getThemeState());
  });
  pending = result.catch(() => undefined);
  return result;
}

/** The page colour of the resolved theme, for window backgrounds. */
export function themeBackground(resolved: ResolvedTheme = getThemeState().resolved): string {
  return THEME_BACKGROUND[resolved];
}

/** The creation-time argument the unlock and settings preloads read for
 * their first frame (`--qrl-theme=dark|light`). */
export function themeArgument(): string {
  return `${THEME_ARGUMENT_PREFIX}${getThemeState().resolved}`;
}
