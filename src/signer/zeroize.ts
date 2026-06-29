/**
 * Best-effort secret-wiping helpers for the signer process.
 *
 * JS/V8 gives no hard guarantee that a buffer is the only copy of its bytes
 * (the GC may have moved it, strings are immutable and uncollectable on
 * demand). We therefore (a) keep all secret material in Buffers/Uint8Arrays
 * rather than strings wherever possible, and (b) overwrite them the instant
 * they are no longer needed. This shrinks the window in which a memory scrape
 * yields key material; it is not a substitute for the process isolation that
 * keeps these bytes out of the renderer and main heaps entirely.
 */

/** Overwrite a byte buffer in place with zeros. Safe on undefined/null. */
export function wipe(buf: Uint8Array | Buffer | null | undefined): void {
  if (buf && buf.length > 0) {
    buf.fill(0);
  }
}

/** Wipe several buffers. */
export function wipeAll(...bufs: Array<Uint8Array | Buffer | null | undefined>): void {
  for (const b of bufs) wipe(b);
}

/**
 * Run `fn` with a secret buffer and guarantee it is wiped afterwards, even if
 * `fn` throws. Mirrors the wallet's `try { ... } finally { wallet.zeroize() }`
 * discipline for any ad-hoc secret buffer.
 */
export async function withWiped<T>(secret: Buffer, fn: (s: Buffer) => Promise<T> | T): Promise<T> {
  try {
    return await fn(secret);
  } finally {
    wipe(secret);
  }
}
