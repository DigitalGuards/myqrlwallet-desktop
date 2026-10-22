# Signing fixtures

`canonical.json` is an unchanged copy of the shared web wallet and Connect SDK
fixture. The copies at frontend revision `103f6ad345796acab69673b04a3fac6fb36d0071`
and SDK revision `9d74a48bb219b7bb03749fb848e2b28ee86b3021` are byte-identical.

`schemeVectors` covers current v1/v2 encoding; `schemeSigningVectors` locks
deterministic ML-DSA-87 outputs using public test seeds. Historical `typedVectors`
contain legacy addresses and exercise rejection. Fixture generation belongs to
the shared wallet/SDK protocol tests.

`confirmation-origin-dev.json` captures all 538 requests from
`confirmationReviewCases.ts` against desktop `origin/dev` revision
`0a6d581795d9c061560991ead7a260f31d87ba8d`. The captured
`src/main/confirmSummary.ts` SHA-256 is
`84d22dc0d0b265c49e3830937d65650d5bd9b5f032eea141b6c438c887c1ab68`.
Its summaries, individual pages, appended approval details and rejection
messages came from running that revision's source from a read-only Git archive.
The corpus includes the review-round-one probes and the original typed-data
and message fixtures, with transaction, escaping and acceptance boundaries.
These are public deterministic test values.

`confirmationParity.test.ts` compares the current English summaries and every
native dialog's text/options directly with this fixed oracle, including page
boundaries and errors. Tests also compare the shown source characters across
all five languages and check the English fallback page assignment. Keep the
oracle pinned when changing translations or layout; tests run without Git or
network access.
