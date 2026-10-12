import { isArray, isRecord } from './guards';
import { TYPED_DATA_LIMITS } from './typedData';

/** 2048 values * 16 KiB * 6 JSON escape bytes, plus declarations and keys,
 * fit below 193 MiB. Hex bytes need at most twice their raw size. */
export const TYPED_DATA_MAX_IPC_BYTES = 256 * 1024 * 1024;

/** Bound the JSON-equivalent size without allocating the whole serialization.
 * Bigints use decimal strings. Semantic validation rejects cyclic values.
 */
export function hasBoundedTypedDataIpcSize(value: unknown): boolean {
  let remaining = TYPED_DATA_MAX_IPC_BYTES;
  // Encoded values, type arrays, field objects with two strings, and the root,
  // types map and primaryType. Bound work even for a wide or shared input tree.
  let remainingNodes =
    TYPED_DATA_LIMITS.maxEncodedValues +
    TYPED_DATA_LIMITS.maxTypes +
    3 * TYPED_DATA_LIMITS.maxTotalFields +
    3;
  const ancestors = new Set<object>();
  const charge = (bytes: number): boolean => {
    remaining -= bytes;
    return remaining >= 0;
  };
  const textFits = (text: string): boolean => {
    if (text.length > remaining || !charge(2)) return false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      if (code < 0x20) {
        bytes = code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
      } else if (code === 0x22 || code === 0x5c) {
        bytes = 2;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(i + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          bytes = 4;
          i++;
        } else {
          bytes = 6; // JSON escapes unpaired UTF-16 surrogates.
        }
      }
      if (!charge(bytes)) return false;
    }
    return true;
  };
  const visit = (item: unknown): boolean => {
    if (--remainingNodes < 0) return false;
    if (typeof item === 'string') return textFits(item);
    // Every valid integer fits in 80 decimal characters, including its sign.
    if (typeof item === 'bigint') return charge(82);
    if (!isArray(item) && !isRecord(item)) return charge(24);
    if (ancestors.has(item)) return true;
    if (ancestors.size >= 64 || !charge(2)) return false;
    ancestors.add(item);
    try {
      if (isArray(item)) {
        for (const entry of item) {
          if (!charge(1) || !visit(entry)) return false;
        }
      } else {
        for (const key in item) {
          if (Object.hasOwn(item, key) && (!textFits(key) || !charge(2) || !visit(item[key]))) {
            return false;
          }
        }
      }
      return true;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value);
}
