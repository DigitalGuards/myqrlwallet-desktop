# Ledger support (in progress)

`src/ledger/` holds the host side of Ledger support for the QRL v2.0 device
app ([theQRL/ledger-app-qrl-v2](https://github.com/theQRL/ledger-app-qrl-v2)).
It is a library today: nothing in the app imports it yet. The device process
(USB HID), the hardware account kind and the signing flow build on it.

## What the module does

- `QrlLedger`: a client over any `LedgerTransport` (one raw APDU in, one raw
  response out). Every app command starts with the BOLOS command `B0 01` and
  goes no further unless the open app is `QRL v2.0`, because other Ledger apps
  share CLA `E0`. Each request runs as one job, and jobs on one transport run
  one at a time across every client that shares it, so a derivation and the
  public key chunk reads that follow it never interleave with another request.
- `getAccount(path)`: derives the account (`E0 05`, P2=0), reads the 2,592-byte
  ML-DSA-87 public key in 11 chunks (P2=1..11, 10 x 258 + 12 bytes) and checks
  that `SHAKE256(01 00 00 || pk)` equals the 64-byte address the device
  returned. The chunks come from whatever the last derivation left in device
  storage, which is why this check exists.
- `verifyAddress(path)`: shows the address on the device (P1=1) and resolves
  once the user confirms it.
- `signTransactionPreimage(path, preimage)`: streams the unsigned type 2
  preimage (`0x02 || rlp([... 11 fields])`) in 255-byte APDUs, waits on the
  last one for the user's decision, then reads the remaining signature chunks
  and returns the 4,627-byte signature (17 x 258 + 241). The device signs
  Keccak-256(preimage) with the context `"ZOND" || 01 || 01 00 00`, the same
  bytes `@theqrl/wallet.js` uses.
- `inspectPreimage`: refuses a structurally invalid preimage before it reaches
  the device and reports whether it is a blind sign (calldata or an access
  list) or a contract creation.
- `createSpeculosTransport`: development transport to the Speculos emulator's
  REST API. It throws in packaged builds (the caller passes `app.isPackaged`)
  and accepts only plain `http` loopback origins, so no other endpoint can
  pose as a device.

Verifying signatures and assembling the signed transaction belong in the
trusted processes. Wherever the client runs, the trusted side repeats the
address check before it relies on a key.

## Device app behavior the client handles

| Situation | theQRL build (main) | cyyber/ledger-app-zond (main, PR #7) |
|---|---|---|
| User rejects | `6985` | `6985` |
| Calldata with Blind signing off | `6985` at once, no screen | notice on the device, then `B008` |
| Largest preimage | 510 bytes (`B004` beyond) | 4,096 (main), 2,048 (PR #7) |
| Wrong app (CLA) / unknown INS | `6E00` / `6D00` | `6E00` / `6D00` |

Both report the name `QRL v2.0` and version 2.2.2, so the host cannot tell them
apart. The client therefore defaults to the 510-byte bound and marks a refused
blind sign with `needsBlindSigning`, so the UI can name the setting next to the
plain meaning of the status.

The review screens differ too, and the fixtures keep them as `deviceScreens`.
The theQRL build shows Chain ID, Gas limit, Priority fee per gas and "Max fees"
as `maxFeePerGas x gas`. The cyyber builds omit the first three rows and show
`maxFeePerGas` itself under "Max fees", a per-gas value. Those strings come
from the device; the client computes none of them.

## Fixtures

`test/fixtures/ledger/*.json` are APDU transcripts recorded on Speculos 0.27.1
(default test seed) from GitHub Actions builds of theQRL/ledger-app-qrl-v2
`main` at `b697908` and of cyyber/ledger-app-zond PR #7 (head `597bc6b` on
base `539e695`), on Nano S Plus and Stax. Each file records its build, CI run,
ELF hashes, the exchanges in order and the expected results. The two live
transfers were broadcast on the QRL testnet (chain 3151909) and mined. The
tests replay these transcripts byte for byte, so they need no emulator.

To record new ones, run Speculos with the REST API enabled (it needs
`qemu-arm-static` on `PATH`), for example
`speculos --model nanosp --display headless --api-port 5000 app.elf`, and point
`createSpeculosTransport({ baseUrl: 'http://127.0.0.1:5000', isPackaged: false })`
at it.
