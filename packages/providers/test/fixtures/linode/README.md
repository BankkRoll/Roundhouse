# Linode fixtures

Response bodies for the Linode (Akamai Cloud) API v4, fetched 2026-10-22.

The official OpenAPI document,
<https://github.com/linode/linode-api-docs> (`development`, `openapi.json`,
version 4.215.0), references its example files rather than embedding them,
so spec examples were assembled from each field's documented `example`
value. Where the endpoint is public, a live response from `api.linode.com`
(which reported `X-Spec-Version: 4.238.0`) was used instead.

| File                       | Source                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `errors.json`              | Live error bodies (`401` without a token; `400` on bad parameters) |
| `get_profile.200.json`     | Spec field examples of `GET /profile`                              |
| `get_type.200.json`        | Live `GET /v4/linode/types/g6-standard-2`                          |
| `get_region.200.json`      | Live `GET /v4/regions/us-east` (resolver lists trimmed)            |
| `get_image.200.json`       | Live `GET /v4/images/linode/ubuntu24.04`                           |
| `get_linode.200.json`      | Spec field examples of the Linode object                           |
| `create_firewall.200.json` | Spec field examples of the Firewall object                         |

`index.ts` builds test scenarios by cloning these objects and overriding only
IDs, labels, tags, prices, and regions. Scenario prices are illustrative.
