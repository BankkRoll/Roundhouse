# Hetzner fixtures

The `*.json` files are response bodies taken from Hetzner's official OpenAPI
document, <https://docs.hetzner.cloud/cloud.spec.json> (fetched 2026-10-22).
Where an operation ships a full example (`create_server`, `poweron_server`,
`apply_firewall_to_resources`), it is copied as is. Otherwise the body is
assembled from the schema's per-field `example` values. They are the shapes
the real API documents, unedited. They moved here unchanged from
`packages/hetzner/test/fixtures/docs`.

`errors.json` holds the error bodies from the "Errors" section of the same
document. The `forbidden`, `rate_limit_exceeded`, and `not_found` messages
are illustrative; the codes and envelope are documented.

`index.ts` builds the test scenarios by cloning those documented objects and
overriding only names, IDs, prices, and availability. Prices and plan names
are illustrative and are not current Hetzner prices.

To refresh: download the spec, regenerate the per-operation examples, and
check the tests still pass.
