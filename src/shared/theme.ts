/**
 * The colour theme: the user's preference and the theme it resolves to.
 * Pure data, shared by main, the wallet preload types and the tests. The
 * sandboxed unlock and settings preloads repeat the literal checks inline
 * (a shared runtime import would become a chunk the sandbox cannot load).
 */

/** The preferences a user can pick. `system` follows the OS appearance. */
export const THEMES = ['dark', 'light', 'system'] as const;
export type ThemePreference = (typeof THEMES)[number];

/** What a preference resolves to on screen. */
export type ResolvedTheme = 'dark' | 'light';

/** The pair main publishes to every surface it styles. */
export interface ThemeState {
  readonly theme: ThemePreference;
  readonly resolved: ResolvedTheme;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEMES.some((theme) => theme === value);
}

export function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return value === 'dark' || value === 'light';
}

/**
 * Window background per resolved theme, painted before any page exists: the
 * page colour of each bundled set (dark `--background`, light hsl(220 20% 96%),
 * the web wallet's Ink and blue page).
 */
export const THEME_BACKGROUND: Readonly<Record<ResolvedTheme, string>> = Object.freeze({
  dark: '#080c16',
  light: '#f3f4f7',
});

/** The creation-time argument that carries the resolved theme to the unlock
 * window and the settings view, for their first frame. */
export const THEME_ARGUMENT_PREFIX = '--qrl-theme=';
