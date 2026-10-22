# Sources

Every endpoint and field was checked against Hetzner's current official API
documentation on 2026-10-22. The reference page is rendered from an OpenAPI
3.1 document, which was read directly:
- OpenAPI document: <https://docs.hetzner.cloud/cloud.spec.json>
- Reference: <https://docs.hetzner.cloud/reference/cloud>
- Changelog: <https://docs.hetzner.cloud/changelog>

## General behaviour

| Topic                                                              | Section                                                                                   | Used for                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| Base URL `https://api.hetzner.cloud/v1`, `Authorization: Bearer`   | [Authentication](https://docs.hetzner.cloud/reference/cloud#description/authentication)   | `HetznerClient`                          |
| Error envelope `{error:{code,message,details}}` and the code table | [Errors](https://docs.hetzner.cloud/reference/cloud#description/errors)                   | `HetznerApiError`, `HETZNER_ERROR_CODES` |
| `page`/`per_page` (max 50), `meta.pagination.next_page`            | [Pagination](https://docs.hetzner.cloud/reference/cloud#description/pagination)           | `paginate`                               |
| `RateLimit-Limit/Remaining/Reset`, 3600/h, refills 1/s, `429`      | [Rate Limiting](https://docs.hetzner.cloud/reference/cloud#description/rate-limiting)     | `waitForBudget`, `retryDelay`            |
| Label key/value grammar, reserved `hetzner.cloud/`                 | [Labels](https://docs.hetzner.cloud/reference/cloud#description/labels)                   | `labels.ts`                              |
| `k=v,k2=v2` selectors                                              | [Label Selector](https://docs.hetzner.cloud/reference/cloud#description/label-selector)   | idempotency lookups                      |
| Actions run until `success` or `error`; poll sparingly             | [Actions](https://docs.hetzner.cloud/reference/cloud#description/actions)                 | `waitForActions`                         |
| Metadata service at `169.254.169.254/hetzner/v1/`                  | [Server Metadata](https://docs.hetzner.cloud/reference/cloud#description/server-metadata) | security notes                           |

## Endpoints

| Call                                                                                                                               | Operation                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /server_types` (`prices[]`, `locations[].available`, `locations[].deprecation`, `category`)                                   | [list_server_types](https://docs.hetzner.cloud/reference/cloud#tag/server-types/list_server_types)                                                                                                                                                                         |
| `GET /locations`                                                                                                                   | [list_locations](https://docs.hetzner.cloud/reference/cloud#tag/locations/list_locations)                                                                                                                                                                                  |
| `GET /pricing` (`currency`, `vat_rate`)                                                                                            | [get_pricing](https://docs.hetzner.cloud/reference/cloud#tag/pricing/get_pricing)                                                                                                                                                                                          |
| `GET /images` (`type`, `status`, `name`, `architecture` filters)                                                                   | [list_images](https://docs.hetzner.cloud/reference/cloud#tag/images/list_images)                                                                                                                                                                                           |
| `GET /ssh_keys`, `POST /ssh_keys`, `DELETE /ssh_keys/{id}`                                                                         | [list_ssh_keys](https://docs.hetzner.cloud/reference/cloud#tag/ssh-keys/list_ssh_keys), [create_ssh_key](https://docs.hetzner.cloud/reference/cloud#tag/ssh-keys/create_ssh_key), [delete_ssh_key](https://docs.hetzner.cloud/reference/cloud#tag/ssh-keys/delete_ssh_key) |
| `GET /firewalls`, `POST /firewalls`                                                                                                | [list_firewalls](https://docs.hetzner.cloud/reference/cloud#tag/firewalls/list_firewalls), [create_firewall](https://docs.hetzner.cloud/reference/cloud#tag/firewalls/create_firewall)                                                                                     |
| `POST /firewalls/{id}/actions/apply_to_resources`                                                                                  | [apply_firewall_to_resources](https://docs.hetzner.cloud/reference/cloud#tag/firewall-actions/apply_firewall_to_resources)                                                                                                                                                 |
| `GET /servers`, `POST /servers` (`user_data` max 32 KiB, `labels`, `firewalls`, `ssh_keys`, `start_after_create`, `root_password`) | [list_servers](https://docs.hetzner.cloud/reference/cloud#tag/servers/list_servers), [create_server](https://docs.hetzner.cloud/reference/cloud#tag/servers/create_server)                                                                                                 |
| `GET /servers/{id}`, `DELETE /servers/{id}`                                                                                        | [get_server](https://docs.hetzner.cloud/reference/cloud#tag/servers/get_server), [delete_server](https://docs.hetzner.cloud/reference/cloud#tag/servers/delete_server)                                                                                                     |
| `POST /servers/{id}/actions/{poweron,poweroff,shutdown,reboot,reset}`                                                              | [Server Actions](https://docs.hetzner.cloud/reference/cloud#tag/server-actions/poweron_server)                                                                                                                                                                             |
| `GET /actions?id=…`                                                                                                                | [get_actions](https://docs.hetzner.cloud/reference/cloud#tag/actions/get_actions)                                                                                                                                                                                          |

## Changelog entries that shaped the code

- [2026-10-12 Link headers are deprecated](https://docs.hetzner.cloud/changelog#2026-10-12-link-header-deprecation): pagination reads `meta.pagination` only.
- [2026-09-08 Field `deprecated` will be removed](https://docs.hetzner.cloud/changelog#2026-09-08-removing-the-deprecated-field) (on 2026-11-02): offers use `locations[].deprecation`; the legacy fields are optional in the types.
- [2026-04-30 `GET /<resource>/{id}/actions/{action_id}` deprecated](https://docs.hetzner.cloud/changelog#2026-04-30-deprecate-get-resource-action-endpoints): actions are polled with `GET /actions?id=`.
- [2025-01-30 Listing arbitrary actions removed](https://docs.hetzner.cloud/changelog#2025-01-30-listing-arbitrary-actions-in-the-actions-list-endpoint-is-removed): `GET /actions` always carries `id`.
- [2026-07-01 Datacenter properties removed](https://docs.hetzner.cloud/changelog#2026-07-01-removing-datacenters): servers are created by `location`.
- [2026-04-22 Leading whitespace in SSH keys is invalid](https://docs.hetzner.cloud/changelog#2026-04-22-ssh-key-validation): keys are trimmed before upload.
- [2025-10-16 New server types](https://docs.hetzner.cloud/changelog#2025-10-16-new-server-types-with-categories) and [old shared types deprecated](https://docs.hetzner.cloud/changelog#2025-10-16-server-types-deprecated): why no plan name or price is hard-coded.
- [2025-08-25 Category for server types](https://docs.hetzner.cloud/changelog#2025-08-25-category-for-server-types): `Offer.category`.

## Firewalls

- [Hetzner Cloud Firewalls overview](https://docs.hetzner.com/cloud/firewalls/overview): with no rule for a direction, inbound is blocked and outbound allowed; 5 firewalls per server; 500 rules per firewall.

## cloud-init

- [Modules reference](https://docs.cloud-init.io/en/latest/reference/modules.html): `write_files` (`path`, `content`, `owner`, `permissions`), `runcmd` (a list entry runs without a shell), and user data stored at `/var/lib/cloud/instance/user-data.txt`.
- [DataSourceHetzner.py](https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/DataSourceHetzner.py): user data is fetched from `http://169.254.169.254/hetzner/v1/userdata`.
- [stages.py](https://github.com/canonical/cloud-init/blob/main/cloudinit/stages.py) and [util.write_file](https://github.com/canonical/cloud-init/blob/main/cloudinit/util.py): the raw and processed user data are cached root-only (0600); `write_files` writes then `chmod`s.

## Not verifiable from the docs

These were chosen to be safe if the assumption is wrong; confirm them once
against a real project:
1. **Token scope probe.** The docs say read-only tokens get `403 forbidden`
   on writes but not whether that check precedes body validation.
   `validateToken` assumes it does (`POST /ssh_keys` with an empty body
   returns `403` for read-only, `422` for read/write). If Hetzner validated
   first, a read-only token would be reported as writable and the first
   real write would then fail with `forbidden`, before any server exists.
2. **IPv6 host address.** The API returns the server's /64. `ipv6` in results
   is `<prefix>::1`, the address Hetzner's images configure; `ipv6Network`
   carries the raw value.
3. **Currency.** `GET /pricing` returns prices in the project owner's
   currency. It is EUR for most accounts; `Offer.currency` reports what the API
   says rather than assuming.
