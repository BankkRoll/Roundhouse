# DigitalOcean fixtures

Response bodies taken from DigitalOcean's official OpenAPI document,
<https://github.com/digitalocean/openapi> (`main`, fetched 2026-10-22), which
generates <https://docs.digitalocean.com/reference/api/digitalocean/>. Each
file is the documented example converted from YAML to JSON, with field names,
types, and values unchanged.

| File                                                | Spec source                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `errors.json`                                       | `shared/responses/*.yml`, plus `resources/tags/responses/tags_bad_request.yml` for the `{error, root_causes}` shape |
| `get_account.200.json`                              | `resources/account/models/account.yml` examples                                                                     |
| `list_sizes.200.json`                               | `resources/sizes/responses/all_sizes.yml`                                                                           |
| `list_regions.200.json`                             | `resources/regions/responses/all_regions.yml`                                                                       |
| `list_images.200.json`                              | `resources/images/responses/all_images.yml`                                                                         |
| `create_droplet.202.json`                           | `resources/droplets/responses/examples.yml#droplet_create_response`                                                 |
| `droplet_networks.json`                             | `networks` of `droplet_single` in the same file; the private `gateway` really is the string `"nil"` there           |
| `get_action.200.json`                               | `resources/actions/responses/action.yml`                                                                            |
| `create_firewall.202.json`                          | `resources/firewalls/responses/create_firewall_response.yml`                                                        |
| `list_ssh_keys.200.json`, `create_ssh_key.201.json` | `resources/ssh_keys/responses/*.yml`                                                                                |
| `create_tag.201.json`                               | `resources/tags/responses/tags_new.yml`                                                                             |

`index.ts` builds test scenarios by cloning these objects and overriding only
IDs, names, slugs, prices, and regions. Scenario prices and slugs are
illustrative, not current DigitalOcean prices.
