# Agent release signing

Every `agent-v*` release publishes:

| File                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `roundhouse-agent-linux-amd64` | Static binary (`CGO_ENABLED=0`)                 |
| `roundhouse-agent-linux-arm64` | Static binary (`CGO_ENABLED=0`)                 |
| `SHA256SUMS`                 | Signed version line plus `sha256sum` output     |
| `SHA256SUMS.sig`             | Raw 64-byte Ed25519 signature over `SHA256SUMS` |

The release also carries a SLSA build provenance attestation for the binaries
and `SHA256SUMS`, produced by `actions/attest-build-provenance`.

`install/install.sh` trusts one thing: the Ed25519 public keys embedded in it
(normally one; two during a rotation). It downloads `SHA256SUMS` and
`SHA256SUMS.sig` and accepts them if any pinned key verifies the signature with

```sh
openssl pkeyutl -verify -pubin -inkey release.pub -rawin \
  -in SHA256SUMS -sigfile SHA256SUMS.sig
```

and only then checks the binary against `SHA256SUMS`. A compromised download
host or a tampered GitHub release asset cannot produce a valid signature.

`SHA256SUMS` starts with a comment line naming the release tag, for example:

```text
# version: agent-v0.1.0
3b1f…  roundhouse-agent-linux-amd64
9c0e…  roundhouse-agent-linux-arm64
```

The line is covered by the signature, so a mirror cannot pass off an older,
correctly signed release as a newer one. When `--version` is pinned, the
install script refuses checksums whose version line names a different tag, and
it refuses any `SHA256SUMS` without one. GNU `sha256sum -c SHA256SUMS` skips
`#` comment lines, so manual checks work unchanged.

Provenance is a second, independent check for people who want it:

```sh
gh attestation verify roundhouse-agent-linux-amd64 --repo BankkRoll/Roundhouse
```

## Generating the key

Do this on a trusted, offline-capable machine with OpenSSL 3.0 or later.

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

## Installing the key

1. **Private key**: in the repository settings, create the environment
   `agent-release` with required reviewers and a deployment rule limited to
   `agent-v*` tags. Add the full PEM contents of `agent-release.key`, including
   the `BEGIN`/`END` lines, as the environment secret
   `AGENT_RELEASE_SIGNING_KEY`. Do not store it as a repository-level secret.
2. **Public key**: replace the placeholder PEM block in
   `RELEASE_PUBLIC_KEYS_PEM` in `install/install.sh` with the full block of
   `agent-release.pub`, verbatim, each line starting at column 0. The release
   workflow extracts every block and refuses to publish unless one of them
   matches the signing key, so a mismatch fails the release rather than every
   install.
3. Store an offline backup of `agent-release.key` (for example, encrypted on two
   hardware-backed devices held by different maintainers), then delete the
   working copy.

## Repository protections

The workflow assumes these settings; configure them before the first release.
- **Tag ruleset**: a ruleset targeting `refs/tags/agent-v*` that restricts
  creation, update and deletion to release maintainers and blocks force pushes.
  Without it, anyone with write access could push a tag and request a signed
  release, and a moved tag could make provenance point at different code.
- **Environment**: `agent-release` requires reviewers and only deploys from
  `agent-v*` tags (see above).

The workflow also enforces, independently of settings:
- the tagged commit must be an ancestor of `origin/main`, so only reviewed code
  is ever signed;
- a release that already has assets is never re-published; re-running a
  release fails instead of replacing signed files. Cut a new tag to fix a bad
  release.

## Rotation

Rotate on a schedule (yearly) and immediately if the key may be exposed: a
leaked secret, a compromised maintainer account with access to the
`agent-release` environment, or a suspicious release.

Planned rotation keeps old and new keys trusted side by side, so installers
fetched before and after the switch both keep working:
1. Generate a new keypair as above.
2. Land a PR that **adds** the new public key as a second PEM block in
   `RELEASE_PUBLIC_KEYS_PEM`, after the current one. The control plane serves
   the updated `install.sh`; releases are still signed with the old key, which
   remains pinned.
3. Replace `AGENT_RELEASE_SIGNING_KEY` in the `agent-release` environment with
   the new private key and cut the next `agent-v*` tag. The workflow's
   key-match check accepts it because the new key is pinned.
4. Once that release is out, land a PR that removes the old block, then destroy
   the old private key and its backups.

The agent binary does not verify release signatures itself; only the install
script does, so running nodes are unaffected by a rotation.

Compromise:
1. Delete `AGENT_RELEASE_SIGNING_KEY` immediately so no further releases can be
   signed with it.
2. Land a PR that **replaces** the compromised block (do not keep it alongside
   the new one), then install the new private key and release as above.
3. Audit releases signed since the suspected exposure against their provenance
   attestations. Delete any release whose binaries do not have a valid
   attestation from this repository's `release-agent.yml` workflow.
4. Publish a security advisory naming the affected releases and the old key's
   fingerprint (`openssl pkey -pubin -in agent-release.pub -outform DER | sha256sum`).

Anyone who saved a copy of `install.sh` pinned to a removed key must fetch the
current one from the control plane.
