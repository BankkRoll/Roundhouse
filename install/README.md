# install

| File                     | What                                             |
| ------------------------ | ------------------------------------------------ |
| `install.sh`             | Installs Docker + agent, joins, starts systemd   |
| `openrail-agent.service` | systemd unit (a copy is embedded in install.sh)  |
| `uninstall.sh`           | Removes agent, config, and state. Leaves Docker. |

The control plane serves `install.sh` at `/install.sh` with its own URL
substituted for `__CONTROL_PLANE_URL__`.

```sh
curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token>
```

Options: `--url`, `--name`, `--version`, `--token-file`, `--rejoin`, `--binary <path>`
(development only; skips signature checks).

## Notes

- Supports Ubuntu 22.04/24.04 and Debian 12, amd64/arm64.
- The binary is verified against `SHA256SUMS`, which is Ed25519-signed with
  the release key embedded in `install.sh`. The embedded key is a placeholder
  until the first release; see `infra/release-signing.md`.
- The token is used within seconds of starting, before the slow package
  installs, and is single-use.
- Keep `openrail-agent.service` and its copy in `install.sh` identical.
