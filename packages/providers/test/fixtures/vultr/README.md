# Vultr fixtures

Response bodies taken from Vultr's official API v2 OpenAPI document (version
"2.0"), which is embedded in <https://www.vultr.com/api/>. The page blocks
automated fetches, so the document was read from the Internet Archive capture
of 2026-10-02
(`http://web.archive.org/web/20261002152210id_/https://www.vultr.com/api/`).
Public endpoints were checked live against `api.vultr.com` on 2026-10-22.

| File                             | Source                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `errors.json`                    | Live error bodies from `api.vultr.com` (2026-10-22); the spec documents only `{error}` |
| `get_account.200.json`           | `get-account` example                                                                  |
| `list_plans.200.json`            | `list-plans` example                                                                   |
| `list_regions.200.json`          | `list-regions` example                                                                 |
| `list_os.200.json`               | `list-os` example                                                                      |
| `create_instance.202.json`       | `create-instance` example, including `default_password`                                |
| `get_instance.200.json`          | `get-instance` example (trimmed to the fields the adapter reads, plus a few)           |
| `create_firewall_group.201.json` | `create-firewall-group` example                                                        |
| `create_firewall_rule.201.json`  | `post-firewalls-firewall-group-id-rules` example                                       |
| `create_ssh_key.201.json`        | `create-ssh-key` example                                                               |

`index.ts` builds test scenarios by cloning these objects and overriding only
IDs, names, plans, prices, and regions. Scenario prices are illustrative, not
current Vultr prices.
