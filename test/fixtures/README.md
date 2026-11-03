# Signing fixtures

`canonical.json` is an unchanged copy of the shared web wallet and Connect SDK
fixture. The copies at frontend revision `103f6ad345796acab69673b04a3fac6fb36d0071`
and SDK revision `9d74a48bb219b7bb03749fb848e2b28ee86b3021` are byte-identical.

`schemeVectors` covers current v1/v2 encoding; `schemeSigningVectors` locks
deterministic ML-DSA-87 outputs using public test seeds. Historical `typedVectors`
contain legacy addresses and exercise rejection. Fixture generation belongs to
the shared wallet/SDK protocol tests.

`signer-tx-vectors.json` pins the bytes of the signer's transaction path. Its
raw transactions and hashes came from `signTransaction` in
`src/signer/signing.ts` under `@theqrl/web3` 1.0.3, the lockfile of desktop
1.4.8 (`recordedWith` lists the packages). The seed is the public test seed
of `schemeSigningVectors`. ML-DSA-87 signing is hedged with one 32-byte draw
from `crypto.getRandomValues`; `test/signer.txVectors.test.ts` answers that
draw with each vector's `rnd` bytes, so a web3 build that encodes and signs
the same way reproduces every vector exactly. Keep the recorded values when a
vector fails: the failure means the signed bytes changed.
