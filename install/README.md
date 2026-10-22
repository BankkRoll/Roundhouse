# install

| File                     | What                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `install.sh`             | Installs Docker, Caddy and the agent, joins, starts systemd |
| `openrail-agent.service` | systemd unit (a copy is embedded in install.sh)             |
| `uninstall.sh`           | Removes agent, config, and state. Leaves Docker and Caddy.  |
| `test/container-test.sh` | End-to-end installer test CI runs on each supported OS      |

The control plane serves `install.sh` at `/install.sh` with its own URL
substituted for `__CONTROL_PLANE_URL__`.

```sh
curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token>
# A builder node, which builds images from git and hosts the local registry:
curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token> --builder
```

Options: `--url`, `--name`, `--version`, `--token-file`, `--rejoin`,
`--builder`, `--binary <path>` (development only; skips signature checks).

## What a node gets

| Component                             | Source                                                                                       | Nodes   |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| Docker Engine                         | download.docker.com apt repository (kept if already installed)                               | all     |
| git, ca-certificates, wireguard-tools | distribution packages                                                                        | all     |
| Caddy                                 | Cloudsmith apt repository; key fingerprint `65760C51EDEA2017CEA2CA15155B6D79CA56EA34` pinned | all     |
| Railpack CLI                          | GitHub release `v0.43.0`, sha256 pinned per architecture                                     | builder |
| BuildKit image                        | `moby/buildkit:v0.34.1-rootless`, pinned by digest, pre-pulled                               | builder |
| Registry image                        | `registry:3.1.2`, pinned by digest, pre-pulled                                               | builder |

### Caddy

Caddy terminates TLS and routes hostnames to containers. The agent owns its
configuration and changes it only through the admin API, which listens on
`localhost:2019`. A systemd drop-in
(`/etc/systemd/system/caddy.service.d/openrail.conf`) replaces the packaged
`ExecStart` with `caddy run --environ --resume`:
- On first start there is no saved config, so Caddy starts empty (admin API
  only) and the packaged Caddyfile is never loaded.
- Caddy autosaves every config the agent pushes, and `--resume` reloads it
  after a restart or reboot, so routes keep serving before the agent
  reconnects.
- `ExecReload` is cleared, because `systemctl reload caddy` would replace
  the agent's config with the Caddyfile.

The apt package was chosen over a pinned binary so Caddy receives security
updates with the rest of the system. Re-running the installer restarts Caddy
only if the drop-in changed.

### Builder nodes

`--builder` passes `--builder` to `openrail-agent join`, which records the
role in `/etc/openrail/agent.yaml`; later re-runs read it from there. To turn
an existing node into a builder, re-run with `--rejoin --builder` and a new
token. Builders need 20 GiB free on `/var/lib`.

The builder runs BuildKit rootless in the `sys_buildkitd` container on its
own bridge network (`openrail-bk0`), so build steps cannot reach host
loopback services such as Caddy's admin API or the registry. It pushes
through a per-build, password-protected proxy the agent opens on that
network's gateway, port 5001.

Pins live at the top of `install.sh` and must match
`agent/internal/builder`; `TestInstallScriptPins` fails if they drift.

## Firewall

The agent dials out to the control plane, so OpenRail needs no inbound port
for control traffic. Open only:

| Port    | Why                       |
| ------- | ------------------------- |
| 80/tcp  | HTTP ingress, ACME        |
| 443/tcp | HTTPS ingress             |
| 443/udp | HTTP/3 ingress (optional) |

Keep SSH restricted as you normally would. When ufw is active the installer
adds these rules, plus, on builders, `allow in on openrail-bk0 to any port
5001 proto tcp` so BuildKit can reach the agent's registry proxy; with other
firewalls, allow the same. Docker publishes no ports for OpenRail's system
containers, and the registry listens on `127.0.0.1:5000` only.

## Notes

- Supports Ubuntu 22.04/24.04 and Debian 12, amd64/arm64.
- The binary is verified against `SHA256SUMS`, which is Ed25519-signed with
  the release key embedded in `install.sh`. The embedded key is a placeholder
  until the first release; see `infra/release-signing.md`.
- The token is used within seconds of starting, before the slow package
  installs, and is single-use.
- Keep `openrail-agent.service` and its copy in `install.sh` identical.
- The agent's sandbox (`openrail-agent.service`) also covers the `git` and
  `railpack` processes a builder runs; checkouts live in
  `/var/lib/openrail/builds` and are deleted after each build.

## Test

```sh
cd agent && CGO_ENABLED=0 GOOS=linux go build -ldflags "-X main.version=0.0.0-ci" \
  -o ../dist/openrail-agent-linux-amd64 ./cmd/openrail-agent && cd ..
docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist:/dist:ro" ubuntu:24.04 \
  bash /src/install/test/container-test.sh
```

It installs Caddy and Railpack for real (network required) and stubs
`systemctl` and `docker`.
