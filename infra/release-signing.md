# Release signing

Roundhouse publishes two kinds of release from this repository, each from its
own workflow and signed with its own key:

| Tag        | Workflow                              | Installer                | Signing secret (environment)                  |
| ---------- | ------------------------------------- | ------------------------ | --------------------------------------------- |
| `agent-v*` | `.github/workflows/release-agent.yml` | `install/install.sh`     | `AGENT_RELEASE_SIGNING_KEY` (`agent-release`) |
| `cli-v*`   | `.github/workflows/release-cli.yml`   | `install/install-cli.sh` | `CLI_RELEASE_SIGNING_KEY` (`cli-release`)     |

The two keys are separate on purpose. The agent runs as root on every node,
so its key is the more valuable one: a leaked CLI key, or a reviewer who can
approve CLI releases, must not be able to ship an agent. Everything below
applies to both unless a section says otherwise; substitute the names from
the table.

## What a release contains

Every `agent-v*` release publishes:

| File                           | Purpose                                         |
| ------------------------------ | ----------------------------------------------- |
| `roundhouse-agent-linux-amd64` | Static binary (`CGO_ENABLED=0`)                 |
| `roundhouse-agent-linux-arm64` | Static binary (`CGO_ENABLED=0`)                 |
| `SHA256SUMS`                   | Signed version line plus `sha256sum` output     |
| `SHA256SUMS.sig`               | Raw 64-byte Ed25519 signature over `SHA256SUMS` |

Every `cli-v*` release publishes:

| File                                             | Purpose                                                      |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `roundhouse-{linux,darwin}-{amd64,arm64}.tar.gz` | `roundhouse` binary, `LICENSE.md`, `README.md`               |
| `roundhouse-windows-{amd64,arm64}.zip`           | `roundhouse.exe`, `LICENSE.md`, `README.md`                  |
| `roundhouse-<os>-<arch>.cdx.json`                | CycloneDX SBOM of each target's Go modules                   |
| `SHA256SUMS`                                     | Signed version line plus checksums of every archive and SBOM |
| `SHA256SUMS.sig`                                 | Raw 64-byte Ed25519 signature over `SHA256SUMS`              |

CLI binaries are built by `cli/scripts/build.sh` with `ARCHIVE=1`:
`CGO_ENABLED=0`, `-trimpath`, version and commit stamped with `-ldflags`, and
archives with fixed entry order, owners and timestamps. The workflow builds
twice and refuses to publish if the two `SHA256SUMS` differ, so anyone can
rebuild a tag with the same Go toolchain (`go.work`) and get the same bytes.

CLI releases are created with `--latest=false`. GitHub's "latest release"
must stay on the agent, because `install.sh` without `--version` downloads
from `/releases/latest/download/`; `install-cli.sh` finds the newest CLI
release through the releases API instead.

Both releases carry a SLSA build provenance attestation for every published
file except the signature, produced by `actions/attest-build-provenance`.

## How installs verify a release

Each installer trusts one thing: the Ed25519 public keys embedded in it
(normally one; two during a rotation). It downloads `SHA256SUMS` and
`SHA256SUMS.sig` and accepts them if any pinned key verifies the signature with

```sh
openssl pkeyutl -verify -pubin -inkey release.pub -rawin \
  -in SHA256SUMS -sigfile SHA256SUMS.sig
```

and only then checks the download against `SHA256SUMS`. A compromised download
host or a tampered GitHub release asset cannot produce a valid signature.

`SHA256SUMS` starts with a comment line naming the release tag, for example:

```text
# version: agent-v0.1.0
3b1f…  roundhouse-agent-linux-amd64
9c0e…  roundhouse-agent-linux-arm64
```

The line is covered by the signature, so a mirror cannot pass off an older,
correctly signed release as a newer one. `install.sh` refuses checksums whose
version line names a different tag when `--version` is pinned, and any
`SHA256SUMS` without one; `install-cli.sh` always knows the tag it wants and
always compares. GNU `sha256sum -c SHA256SUMS` skips `#` comment lines, so
manual checks work unchanged.

`install-cli.sh` needs OpenSSL 3 for the check. macOS ships LibreSSL, which
cannot verify raw Ed25519 signatures, so the script also looks for
Homebrew's `openssl@3`; `--insecure-skip-signature` checks the checksum
only and says so.

Provenance is a second, independent check for people who want it:

```sh
gh attestation verify roundhouse-agent-linux-amd64 --repo BankkRoll/Roundhouse
gh attestation verify roundhouse-linux-amd64.tar.gz --repo BankkRoll/Roundhouse
```

## Generating a key

Do this on a trusted, offline-capable machine with OpenSSL 3.0 or later. The
example names the agent key; use `cli-release` for the CLI.

```sh
umask 077
openssl genpkey -algorithm ed25519 -out agent-release.key
openssl pkey -in agent-release.key -pubout -out agent-release.pub
```

`agent-release.key` is a PKCS#8 PEM file (`-----BEGIN PRIVATE KEY-----`).
`agent-release.pub` is an SPKI PEM file (`-----BEGIN PUBLIC KEY-----`).

Sanity check:

```sh
echo test > msg
openssl pkeyutl -sign -rawin -inkey agent-release.key -in msg -out msg.sig
openssl pkeyutl -verify -pubin -inkey agent-release.pub -rawin -in msg -sigfile msg.sig
```

## Installing a key

1. **Private key**: in the repository settings, create the environment
   (`agent-release` or `cli-release`) with required reviewers and a
   deployment rule limited to its tags (`agent-v*` or `cli-v*`). Add the full
   PEM contents of the private key, including the `BEGIN`/`END` lines, as the
   environment secret (`AGENT_RELEASE_SIGNING_KEY` or
   `CLI_RELEASE_SIGNING_KEY`). Do not store either as a repository-level
   secret.
2. **Public key**: replace the placeholder PEM block in
   `RELEASE_PUBLIC_KEYS_PEM` in the installer (`install/install.sh` or
   `install/install-cli.sh`) with the full public key block, verbatim. In
   `install.sh` each line starts at column 0 inside the heredoc; in
   `install-cli.sh` the blocks sit inside the single-quoted string. The
   release workflow reads every pinned block and refuses to publish unless
   one matches the signing key, so a mismatch fails the release rather than
   every install.
3. Store an offline backup of the private key (for example, encrypted on two
   hardware-backed devices held by different maintainers), then delete the
   working copy.

Until step 2, each installer carries a placeholder whose private half was
discarded: `install.sh` then refuses downloads (only `--binary` works) and
`install-cli.sh` refuses unless `--insecure-skip-signature` is given.

## Repository protections

The workflows assume these settings; configure them before the first release.
- **Tag rulesets**: rulesets targeting `refs/tags/agent-v*` and
  `refs/tags/cli-v*` that restrict creation, update and deletion to release
  maintainers and block force pushes. Without them, anyone with write access
  could push a tag and request a signed release, and a moved tag could make
  provenance point at different code.
- **Environments**: `agent-release` and `cli-release` require reviewers and
  only deploy from their own tags (see above).

The workflows also enforce, independently of settings:
- the tagged commit must be an ancestor of `origin/main`, so only reviewed code
  is ever signed;
- a release that already has assets is never re-published; re-running a
  release fails instead of replacing signed files. Cut a new tag to fix a bad
  release.

## Rotation

Rotate on a schedule (yearly) and immediately if a key may be exposed: a
leaked secret, a compromised maintainer account with access to the release
environment, or a suspicious release. The agent and CLI keys rotate
independently.

Planned rotation keeps old and new keys trusted side by side, so installers
fetched before and after the switch both keep working:
1. Generate a new keypair as above.
2. Land a PR that **adds** the new public key as a second PEM block in the
   installer's `RELEASE_PUBLIC_KEYS_PEM`, after the current one. Installers
   fetched from then on trust both; releases are still signed with the old
   key, which remains pinned. (The control plane serves the updated
   `install.sh`; `install-cli.sh` is fetched from `main`.)
3. Replace the signing secret in the release environment with the new private
   key and cut the next tag. The workflow's key-match check accepts it because
   the new key is pinned.
4. Once that release is out, land a PR that removes the old block, then destroy
   the old private key and its backups.

Neither the agent nor the CLI binary verifies release signatures itself; only
the install scripts do, so running nodes and installed CLIs are unaffected by
a rotation.

Compromise:
1. Delete the signing secret immediately so no further releases can be signed
   with it.
2. Land a PR that **replaces** the compromised block (do not keep it alongside
   the new one), then install the new private key and release as above.
3. Audit releases signed since the suspected exposure against their provenance
   attestations. Delete any release whose files do not have a valid
   attestation from this repository's release workflow for that kind of tag.
4. Publish a security advisory naming the affected releases and the old key's
   fingerprint (`openssl pkey -pubin -in agent-release.pub -outform DER | sha256sum`).

Anyone who saved a copy of an installer pinned to a removed key must fetch the
current one (`install.sh` from the control plane, `install-cli.sh` from
`main`).
