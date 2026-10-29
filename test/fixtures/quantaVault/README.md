# QuantaVault decoder parity vectors

Protocol source: DigitalGuards/QuantaVault commit `926c02470b6cde621a66e9ce7b1888b706752d58`.

The recognizer, calldata decoder, selector constants and these nine JSON files mirror DigitalGuards/myqrlwallet-frontend commit `839d0ba19c3a761579723a630b8b0fbd1536009d` (pull request #424, based on `d5da2031b203f72bbe481cadc8b11da4499b0740`). The source files' SHA-256 identifiers at that commit are:

| Source file | SHA-256 |
| --- | --- |
| `src/utils/signing/quantaVault.ts` | `60ab78de1bdba48d06397d7098e3ce8335494f69e6bd4c43426f6cb4f46b3d0c` |
| `src/utils/signing/quantaVaultCalldata.ts` | `2958f4acd87a878884ac45eb0ff27fe50dafa30f74abc5e863ae41e000b32dc8` |
| `src/utils/signing/quantaVaultSelectors.ts` | `abc58857961d9f3ebf243ce5e403cc3fbdb3dcb957bc36f844a2a1c2c145613b` |

Desktop adaptations use the existing shared address/record guards, local imports and strict lint/type rules. The deployment configuration contains only an empty main-owned MultiSendCallOnly map. Every DelegateCall warning remains enabled with this map. No application-origin hint, QNS lookup or renderer token registry is used. Token amounts use base units and full contract addresses. The main confirmation adds provenance markers, bounded pagination and refund refusal independently of the signer.

The JSON fixture bytes are unchanged:

- `multi-send.json`, `proposals.json` and `timelock.json`: SDK packed batches, proposal tuples and timelock encodings.
- `typed-data-v2.json`, `vault-approvals.json` and `nested-vaults.json`: typed schemas, encoded type strings, type hashes and complete digests for all three request kinds, including nested approvals and opaque messages.
- `timelock-vault.json`: scheduled ownership handoffs.
- `selectors.json`: ABI names, inputs, signatures and selectors from the protocol's pinned compiler; QRC-20 and ownership entries also use the frontend ABI at the base revision above.
- `calldata.json`: SDK-generated calls for every supported selector, including dynamic arrays, full-width addresses, exact amounts, ownership and DelegateCall batches.

The tests recompute every selector and role constant inside the test crypto boundary. Main and shared decoding code import no hashing primitive. ABI decoding uses 64-byte QRVM words and a 193-byte packed batch header. Canonical padding, offsets, bounds, integer widths and complete input consumption are required. One level of enclosed calls is expanded; deeper calls retain their bytes and a warning. A selector describes the supplied bytes without authenticating the destination contract.
