/** Native QIP-55 account address shape shared by every process boundary. */
export const QRL_ADDRESS_HEX_LENGTH = 128;
export const QRL_ADDRESS_LENGTH = 1 + QRL_ADDRESS_HEX_LENGTH;
export const QRL_ADDRESS_PATTERN = /^Q[0-9a-fA-F]{128}$/;
const LEGACY_QRL_ADDRESS_PATTERN = /^Q[0-9a-fA-F]{40}$/;
const DISPLAYABLE_QRL_ADDRESS_PATTERN = /^Q(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{128})$/;
const DISPLAY_SEGMENT_LENGTH = 8;

export function isQrlAddress(value: unknown): value is string {
  return typeof value === 'string' && QRL_ADDRESS_PATTERN.test(value);
}

/** Identify pre-QIP-55 metadata for preservation and migration only. */
export function isLegacyQrlAddress(value: unknown): value is string {
  return typeof value === 'string' && LEGACY_QRL_ADDRESS_PATTERN.test(value);
}

/** Compact a QRL address while preserving checksum case in every visible segment. */
export function formatQrlAddressFingerprint(address: string): string {
  if (!DISPLAYABLE_QRL_ADDRESS_PATTERN.test(address)) return address;

  const body = address.slice(1);
  if (body.length < DISPLAY_SEGMENT_LENGTH * 3) return address;

  const middleStart = Math.floor((body.length - DISPLAY_SEGMENT_LENGTH) / 2);
  return [
    `Q${body.slice(0, DISPLAY_SEGMENT_LENGTH)}`,
    body.slice(middleStart, middleStart + DISPLAY_SEGMENT_LENGTH),
    body.slice(-DISPLAY_SEGMENT_LENGTH),
  ].join('...');
}

/** Group a full QRL address for review without changing its copied or signed value. */
export function groupQrlAddress(address: string): string {
  if (!DISPLAYABLE_QRL_ADDRESS_PATTERN.test(address)) return address;
  const groups = address.slice(1).match(/.{1,8}/g);
  return groups ? `Q${groups.join(' ')}` : address;
}
