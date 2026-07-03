/**
 * qrlconnect:// URI ingress for the OS protocol handler.
 *
 * Main treats the URI as an opaque hostile string: it validates ONLY the
 * shape (scheme, length, charset) and never parses the payload blob. Parsing
 * and fingerprint pinning stay in the renderer's audited dApp-connect stack
 * (myqrlwallet-frontend `qrUri.ts`), behind its consent modal, so there is
 * exactly one hostile-input parser for connection URIs across web, mobile
 * and desktop.
 *
 * The ingress also owns the two delivery quirks of protocol handlers:
 *   - Cold start: the URI arrives in argv before the renderer exists, so it
 *     is buffered (depth 1, latest wins) and flushed on renderer load.
 *   - Hostile flood: any webpage or local process can fire qrlconnect://
 *     launches; a rate limit keeps them from spamming the renderer with
 *     consent modals.
 */

/** Upper bound for an acceptable URI. QR-sized payloads are ~1KB; 4KB is generous. */
export const DAPP_URI_MAX_LENGTH = 4096;

/** Minimum interval between two accepted URIs (hostile-flood damping). */
export const DAPP_URI_RATE_LIMIT_MS = 2000;

/**
 * Shape-validate a candidate qrlconnect:// URI. Scheme (case-insensitive),
 * bounded length, visible ASCII only (spaces, control chars and non-ASCII
 * rejected; a URI never legitimately contains them, and the PQP2 payload is
 * base45/URL-safe, so this never rejects a real URI).
 */
export function isValidDappUri(uri: string): boolean {
  if (typeof uri !== 'string') return false;
  if (uri.length < 'qrlconnect:'.length + 1 || uri.length > DAPP_URI_MAX_LENGTH) return false;
  if (!/^qrlconnect:/i.test(uri)) return false;
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i);
    if (c <= 0x20 || c > 0x7e) return false;
  }
  return true;
}

/**
 * Pick the qrlconnect:// URI out of an argv vector (cold start or
 * second-instance on Windows/Linux). Only the FIRST matching argument is
 * consumed as data; everything else in argv is ignored, never executed.
 */
export function extractDappUriFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && /^qrlconnect:/i.test(arg)) return arg;
  }
  return null;
}

export type DappUriOfferResult = 'delivered' | 'buffered' | 'rejected';

interface DappUriIngressDeps {
  /**
   * Hand a validated URI to the renderer. MUST check live window state and
   * return false when the renderer cannot receive right now (no window,
   * window destroyed, main frame mid-load); the URI is then buffered for the
   * next rendererReady(). Readiness is deliberately NOT tracked here with
   * did-start-loading/did-finish-load bookkeeping: those events do not pair
   * one-to-one (a stray did-start-loading left the flag stuck false in the
   * field, silently buffering every warm-start URI forever).
   */
  deliver: (uri: string) => boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class DappUriIngress {
  private readonly deliver: (uri: string) => boolean;
  private readonly now: () => number;
  private pending: string | null = null;
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: DappUriIngressDeps) {
    this.deliver = deps.deliver;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Offer a raw URI from any ingress path (argv, second-instance, open-url).
   * Invalid or rate-limited URIs are dropped; otherwise delivery is attempted
   * immediately and the URI is buffered on failure (depth 1, latest wins).
   */
  offer(raw: string): DappUriOfferResult {
    if (!isValidDappUri(raw)) return 'rejected';
    const t = this.now();
    if (t - this.lastAcceptedAt < DAPP_URI_RATE_LIMIT_MS) return 'rejected';
    this.lastAcceptedAt = t;
    if (this.deliver(raw)) return 'delivered';
    this.pending = raw;
    return 'buffered';
  }

  /** The renderer finished loading: flush any buffered URI. */
  rendererReady(): void {
    if (this.pending !== null) {
      const uri = this.pending;
      this.pending = null;
      if (!this.deliver(uri)) this.pending = uri;
    }
  }
}
