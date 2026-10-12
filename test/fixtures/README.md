# Signing fixtures

`canonical.json` is an unchanged copy of the shared web wallet and Connect SDK
fixture. The copies at frontend revision `103f6ad345796acab69673b04a3fac6fb36d0071`
and SDK revision `9d74a48bb219b7bb03749fb848e2b28ee86b3021` are byte-identical.

`schemeVectors` covers current v1/v2 encoding; `schemeSigningVectors` locks
deterministic ML-DSA-87 outputs using public test seeds. Historical `typedVectors`
contain legacy addresses and exercise rejection. Fixture generation belongs to
the shared wallet/SDK protocol tests.
