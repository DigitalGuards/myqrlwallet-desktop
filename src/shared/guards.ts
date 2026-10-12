/**
 * Runtime type guards for untrusted input (IPC messages, utilityProcess
 * messages, files read from disk, JSON.parse results). The hardening mandate
 * bans type assertions, so every wire value enters the typed world through a
 * guard. Pure and dependency-free so any process may import it.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Array.isArray narrows unknown to any[], which silently re-launders every
 * element; this predicate keeps the elements unknown.
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** The `code` of a Node system error (ENOENT, EACCES, ...), else undefined. */
export function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

/** Coerce an unknown caught value into an Error without losing the message. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error('Unknown error');
}
