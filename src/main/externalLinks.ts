/**
 * External-link policy: the wallet UI may hand a clicked link to the OS browser
 * only if it targets a trusted QRL-ecosystem host over https.
 *
 * Without an allowlist, a compromised renderer could call `window.open` (or
 * drive a `will-navigate`) to make the main process launch an ARBITRARY https
 * URL in the user's real browser, a phishing and tracking vector. Restricting
 * `shell.openExternal` to known ecosystem hosts contains that. Arbitrary
 * token / NFT / dApp-supplied URLs (e.g. an NFT `external_url`, a dApp site) are
 * deliberately NOT auto-opened: clicking them is a no-op rather than a launch.
 *
 * Pure (no Electron runtime import) so the host-matching boundary is unit
 * testable; `security.ts` wires it into the navigation handlers.
 */

/**
 * Trusted external hosts. A URL is allowed if its host is one of these exactly,
 * or a subdomain of one (matched on a dot boundary).
 */
export const EXTERNAL_ALLOWLIST = [
  'qrlwallet.com', // first-party site (incl. dev.qrlwallet.com staging)
  'zondscan.com', // block explorer: transaction / address links
  'theqrl.org', // QRL project
  'github.com', // DigitalGuards repository / issue links
  't.me', // community / support telegram
];

/**
 * True iff `url` is an https URL whose host is in EXTERNAL_ALLOWLIST, matched as
 * an exact host or a subdomain on a dot boundary (so `evil-zondscan.com` and
 * `zondscan.com.evil.test` are rejected). https is required so a compromised
 * renderer cannot use `shell.openExternal` to launch `file:`, a custom protocol
 * handler, or another dangerous scheme.
 */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return EXTERNAL_ALLOWLIST.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
