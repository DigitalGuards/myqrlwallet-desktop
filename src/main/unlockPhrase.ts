/** Main-only personal mark. These words and their order stay fixed across locales.
 * Four independent uniform selections from 64 words give 24 random bits.
 * This visual cue is readable by same-user malware and is never a password. */
const WORDS = `
acorn amber apple arch autumn bay beach birch
bird bloom blue boat breeze brook cedar cherry
cloud coral dawn deer dune fern field finch
forest frost garden glade gold grape green grove
harbor hazel hill honey iris island ivy jade
lake leaf lemon lilac lime maple meadow mint
moon moss ocean olive orange otter peach pearl
pine plum pond rain reed river rose silver
`
  .trim()
  .split(/\s+/u);

export function generateUnlockPhrase(): string {
  // WebCrypto uses the main process CSPRNG. A six-bit mask is unbiased for
  // this fixed 64-word list; no wallet key or signer primitive is involved.
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (byte) => {
    const word = WORDS[byte & 63];
    if (!word) throw new Error('invalid personal phrase word list');
    return word;
  }).join(' ');
}
