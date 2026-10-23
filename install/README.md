# install

| File                           | What                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| `install.sh`                   | Installs Docker, Caddy and the agent, joins, starts systemd  |
| `roundhouse-agent.service`     | systemd unit (a copy is embedded in install.sh)              |
| `roundhouse-buildkit.apparmor` | BuildKit's AppArmor profile (a copy is embedded, too)        |
| `agent.example.yaml`           | Annotated `/etc/roundhouse/agent.yaml` (written by `join`)   |
| `uninstall.sh`                 | Removes agent, config, and state. Leaves Docker and Caddy.   |
| `install-cli.sh`               | Installs the `roundhouse` CLI from a signed GitHub release   |
| `test/container-test.sh`       | End-to-end installer test CI runs on each supported OS       |
| `test/install-cli-test.sh`     | CLI installer test against a fake release signed in the test |

The control plane serves `install.sh` at `/install.sh` with its own URL
substituted for `__CONTROL_PLANE_URL__`.

```sh
curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token>
# A builder node, which builds images from git and hosts the local registry:
curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token> --builder
```

Options: `--url`, `--name`, `--version`, `--token-file`, `--rejoin`,
`--builder`, `--binary <path>` (development only; skips signature checks).
Every option and environment variable, and the agent's config file, are in
[docs/configuration.md](../docs/configuration.md#node-installer).

The CLI has its own installer, for Linux and macOS workstations; see
[cli/README.md](../cli/README.md#install).

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
(`/etc/systemd/system/caddy.service.d/roundhouse.conf`) replaces the packaged
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

`--builder` passes `--builder` to `roundhouse-agent join`, which records the
role in `/etc/roundhouse/agent.yaml`; later re-runs read it from there. To turn
an existing node into a builder, re-run with `--rejoin --builder` and a new
token. Builders need 20 GiB free on `/var/lib`.

The builder runs BuildKit rootless, one `sys_buildkitd-<project>` container
per project (at most two running, each stopped after 10 idle minutes), on
its own bridge network (`roundhouse-bk0`), so build steps cannot reach host
loopback services such as Caddy's admin API or the registry, and one
project's build cache is never visible to another's builds. It pushes
through a per-build, password-protected proxy the agent opens on that
network's gateway, port 5001.

### AppArmor

Ubuntu 23.10 and later restrict unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=1`), which rootless BuildKit
needs. On builders whose kernel supports that restriction, whatever its
current value, the installer writes `/etc/apparmor.d/roundhouse-buildkit`
(source: `roundhouse-buildkit.apparmor`), installs `apparmor` if
`apparmor_parser` is missing, and loads the profile; the agent then runs
`sys_buildkitd` under it. The profile grants `userns` and is otherwise
unconfined, like the `apparmor=unconfined` BuildKit is documented with, and
attaches to no program, so the host-wide restriction stays on for
everything else. If the profile cannot be loaded while the restriction is
on, the installer stops; with it off, it warns and continues. AppArmor older
than 4.0 (Ubuntu 22.04, Debian 12) cannot parse the `userns` rule, but those
releases do not restrict user namespaces either.

If builds fail with `fork/exec /proc/self/exe: permission denied`, check
that `sudo grep roundhouse-buildkit /sys/kernel/security/apparmor/profiles`
lists the profile and load it with `sudo apparmor_parser -r
/etc/apparmor.d/roundhouse-buildkit` if it does not. As a last resort,
`sysctl kernel.apparmor_restrict_unprivileged_userns=0` (persisted in
`/etc/sysctl.d/`) also works, but lifts the restriction for every program
on the host; the installer never does this.

Pins live at the top of `install.sh` and must match
`agent/internal/builder`; `TestInstallScriptPins` fails if they drift.

## Firewall

The agent dials out to the control plane, so Roundhouse needs no inbound port
for control traffic. Open only:

| Port    | Why                       |
| ------- | ------------------------- |
| 80/tcp  | HTTP ingress, ACME        |
| 443/tcp | HTTPS ingress             |
| 443/udp | HTTP/3 ingress (optional) |

Keep SSH restricted as you normally would. When ufw is active the installer
adds these rules, plus, on builders, `allow in on roundhouse-bk0 to any port
5001 proto tcp` so BuildKit can reach the agent's registry proxy; with other
firewalls, allow the same. Docker publishes no ports for Roundhouse's system
containers, and the registry listens on `127.0.0.1:5000` only.

## Notes

- Supports Ubuntu 22.04/24.04 and Debian 12, amd64/arm64.
- The binary is verified against `SHA256SUMS`, which is Ed25519-signed with
  the release key embedded in `install.sh`. The embedded key is a placeholder
  until the first release; see `infra/release-signing.md`.
- The token is used within seconds of starting, before the slow package
  installs, and is single-use.
- Keep `roundhouse-agent.service` and `roundhouse-buildkit.apparmor`
  identical to their copies in `install.sh`; CI and
  `TestInstallerEmbedsAppArmorProfile` check them.
- The agent's sandbox (`roundhouse-agent.service`) also covers the `git` and
  `railpack` processes a builder runs; checkouts live in
  `/var/lib/roundhouse/builds` and are deleted after each build.

## Test

```sh
cd agent && CGO_ENABLED=0 GOOS=linux go build -ldflags "-X main.version=0.0.0-ci" \
  -o ../dist/roundhouse-agent-linux-amd64 ./cmd/roundhouse-agent && cd ..
docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist:/dist:ro" ubuntu:24.04 \
  bash /src/install/test/container-test.sh
```

It installs Caddy and Railpack for real (network required) and stubs
`systemctl` and `docker`.
