# QuantaVault decoder parity vectors

Protocol source: DigitalGuards/QuantaVault commit `926c02470b6cde621a66e9ce7b1888b706752d58`.

The recognizer, calldata decoder, selector constants and these ten JSON files mirror DigitalGuards/myqrlwallet-frontend commit `f38d836c03aa8a5cc3da94bd46b6c4582f11158b` (pull request #424, based on `d5da2031b203f72bbe481cadc8b11da4499b0740`). The source files' SHA-256 identifiers at that commit are:

| Source file | SHA-256 |
| --- | --- |
| `src/utils/signing/quantaVault.ts` | `60ab78de1bdba48d06397d7098e3ce8335494f69e6bd4c43426f6cb4f46b3d0c` |
| `src/utils/signing/quantaVaultCalldata.ts` | `de56d7173dd03e4a4f53562d1a5200deff00f62146e6e93d512fa86dba8038ec` |
| `src/utils/signing/quantaVaultSelectors.ts` | `abc58857961d9f3ebf243ce5e403cc3fbdb3dcb957bc36f844a2a1c2c145613b` |

Desktop adaptations use the existing shared address/record guards, local imports, a shared batch-method set and strict lint/type rules. The deployment configuration contains only an empty main-owned MultiSendCallOnly map. Every DelegateCall warning remains enabled with this map. No application-origin hint, QNS lookup or renderer token registry is used. Amounts use base units and full QIP-55 checksum addresses. The shared approve and transferFrom selectors identify a QRC-20 amount or NFT token ID. The main confirmation adds provenance markers, bounded pagination and refund refusal independently of the signer.

The ten JSON fixture files retain the frontend source bytes:

- `multi-send.json`, `proposals.json` and `timelock.json`: SDK packed batches, proposal tuples and timelock encodings.
- `typed-data-v2.json`, `vault-approvals.json` and `nested-vaults.json`: typed schemas, encoded type strings, type hashes and complete digests for all three request kinds, including nested approvals and opaque messages.
- `timelock-vault.json`: scheduled ownership handoffs.
- `selectors.json`: ABI names, inputs, signatures and selectors from the protocol's pinned compiler; QRC-20 and ownership entries also use the frontend ABI at the base revision above.
- `calldata.json`: SDK-generated calls for every supported selector, including dynamic arrays, full-width addresses, exact amounts, ownership and DelegateCall batches.
- `review-cases.json`: zero-target Call and DelegateCall batches for both approval kinds, scheduled updateDelay, zero-role revocation, unlimited approval, invalid operation, expired validity and nonzero txGas. Tests preserve the reference digests and use the fixed reviewTime for expiry boundaries.

The tests recompute every selector and role constant inside the test crypto boundary. Calldata decoding uses precomputed constants. Public address display uses the existing shared QIP-55 checksum helper and its public-data SHAKE256 exception. ABI decoding uses 64-byte QRVM words and a 193-byte packed batch header. Canonical padding, offsets, bounds, integer widths and complete input consumption are required. One level of enclosed calls is expanded; deeper calls retain their bytes and a warning. A selector describes the supplied bytes without authenticating the destination contract.

Fixture SHA-256 identifiers at the frontend revision above:

| Fixture | SHA-256 |
| --- | --- |
| `calldata.json` | `791b1fa80a9e150144939cb59722037b123891387e2a064c7a3bb18e005bef2b` |
| `multi-send.json` | `e4691f74a8d700bd0df54a8512d968951731c894214362ef5471daf80017a24b` |
| `nested-vaults.json` | `9a2e3c69dcdb1f8f605cf92b0c44d503ef933b25f4038537d0d95e5ffa09db48` |
| `proposals.json` | `9cf8b8ae65c2eddd9aa6e8bc79576b6f50fc45405c368854924a3ed2bedd3bf2` |
| `review-cases.json` | `9a7e2e4772185617b6722c0bf18c212875b50c548f08483660f348bcd50ff33b` |
| `selectors.json` | `eb23719a31ac685bb2c636de8d24df15ff022db263e33b19b8cd9ba033ab0a7b` |
| `timelock-vault.json` | `ff70ba935d8e2fa53c57cfa8246a738a8fa574604006b3062f7706094f42555f` |
| `timelock.json` | `bd21a780d81d648b347ded8dc46fe098503469eed4613cd6614edfdd7e239859` |
| `typed-data-v2.json` | `a0f446b652e05a010be24a53c0a7465d6d0c3c63622b456ca47470b79b998a13` |
| `vault-approvals.json` | `8efab2e168c641795f7b6f0107fbeb38c1b471cf189cd17e37b4e9fa86549b16` |
