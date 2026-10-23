#!/bin/sh
#
# Installs the roundhouse CLI on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/BankkRoll/Roundhouse/main/install/install-cli.sh | sh
#   curl -fsSL …/install-cli.sh | sh -s -- --version 0.1.0 --dir /usr/local/bin
#
# Options:
#   --version <v>   CLI version to install, e.g. 0.1.0 (default: the newest
#                   cli-v* release that is not a prerelease).
#   --dir <path>    Install directory (default: /usr/local/bin as root, else
#                   ~/.local/bin).
#   --insecure-skip-signature
#                   Check the archive against SHA256SUMS without verifying
#                   the signature on SHA256SUMS. Only for hosts without
#                   OpenSSL 3; prefer installing it.
#
# Environment:
#   ROUNDHOUSE_CLI_VERSION    Same as --version.
#   ROUNDHOUSE_INSTALL_DIR    Same as --dir.
#   ROUNDHOUSE_DOWNLOAD_BASE  Release download base (default:
#                             https://github.com/BankkRoll/Roundhouse/releases/download).
#                             Version v is fetched from <base>/cli-v<v>/. A
#                             mirror needs an explicit version.
#
# What is verified: SHA256SUMS must carry an Ed25519 signature from one of the
# release keys pinned below and name the requested tag on its signed version
# line; only then is the archive checked against it. See
# infra/release-signing.md. Windows: download roundhouse-windows-<arch>.zip
# from the release and check it against SHA256SUMS by hand.

set -eu

REPO="BankkRoll/Roundhouse"

# IMPORTANT: CLI release-signing public keys, one PEM block each, verbatim as
# `openssl pkey -pubout` prints them. SHA256SUMS is accepted if any of them
# verifies it, which lets a rotation ship the next key before it is used (see
# infra/release-signing.md). The block below is a PLACEHOLDER whose private
# half was discarded; replace it before the first CLI release. While it is
# present, signed installs are refused.
RELEASE_PUBLIC_KEYS_PEM='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZvzye3OODLHiefWH/qsfIHqNyVR7gw8jC3iEzqqEfxI=
-----END PUBLIC KEY-----'
PLACEHOLDER_KEY_DER_B64="MCowBQYDK2VwAyEAZvzye3OODLHiefWH/qsfIHqNyVR7gw8jC3iEzqqEfxI="

DEFAULT_DOWNLOAD_BASE="https://github.com/${REPO}/releases/download"
DOWNLOAD_BASE="${ROUNDHOUSE_DOWNLOAD_BASE:-$DEFAULT_DOWNLOAD_BASE}"
VERSION="${ROUNDHOUSE_CLI_VERSION:-}"
INSTALL_DIR="${ROUNDHOUSE_INSTALL_DIR:-}"
SKIP_SIGNATURE=0
WORK_DIR=""
OPENSSL=""

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: install-cli.sh [--version <v>] [--dir <path>] [--insecure-skip-signature]

  --version <v>               CLI version, e.g. 0.1.0 (default: newest release)
  --dir <path>                install directory (default: /usr/local/bin as
                              root, else ~/.local/bin)
  --insecure-skip-signature   skip the SHA256SUMS signature check (not the
                              checksum); only for hosts without OpenSSL 3

Environment: ROUNDHOUSE_CLI_VERSION, ROUNDHOUSE_INSTALL_DIR,
ROUNDHOUSE_DOWNLOAD_BASE (a mirror of the GitHub release layout).
EOF
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--version)
			[ $# -ge 2 ] || die "--version needs a value"
			VERSION="$2"
			shift 2
			;;
		--version=*)
			VERSION="${1#*=}"
			shift
			;;
		--dir)
			[ $# -ge 2 ] || die "--dir needs a value"
			INSTALL_DIR="$2"
			shift 2
			;;
		--dir=*)
			INSTALL_DIR="${1#*=}"
			shift
			;;
		--insecure-skip-signature)
			SKIP_SIGNATURE=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown option: $1 (see --help)" ;;
		esac
	done
	VERSION="${VERSION#v}"
	VERSION="${VERSION#cli-v}"
	case "$VERSION" in
	"" | [0-9]*) ;;
	*) die "--version must look like 0.1.0, got: $VERSION" ;;
	esac
	case "$VERSION" in
	*[!0-9A-Za-z.+-]*) die "--version contains unexpected characters: $VERSION" ;;
	esac
}

detect_platform() {
	case "$(uname -s)" in
	Linux) OS=linux ;;
	Darwin) OS=darwin ;;
	MINGW* | MSYS* | CYGWIN*) die "on Windows, download roundhouse-windows-<arch>.zip from https://github.com/${REPO}/releases" ;;
	*) die "unsupported operating system: $(uname -s)" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die "unsupported architecture: $(uname -m)" ;;
	esac
	# COMPAT: under Rosetta 2, uname reports x86_64 on Apple silicon; the
	# native arm64 build is the better choice there.
	if [ "$OS" = darwin ] && [ "$ARCH" = amd64 ] &&
		[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
		ARCH=arm64
	fi
}

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q --https-only -O "$2" "$1"
	else
		die "curl or wget is required"
	fi
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{ print $1 }'
	else
		die "sha256sum or shasum is required"
	fi
}

# resolve_latest sets VERSION to the newest published cli-v* release.
#
# NOTE: GitHub's /releases/latest belongs to the agent (install.sh fetches
# it), and CLI releases are published with --latest=false, so the newest CLI
# release has to be looked up in the release list instead.
resolve_latest() {
	[ "$DOWNLOAD_BASE" = "$DEFAULT_DOWNLOAD_BASE" ] ||
		die "ROUNDHOUSE_DOWNLOAD_BASE is set, so pass --version: a mirror has no release list"
	fetch "https://api.github.com/repos/${REPO}/releases?per_page=100" "${WORK_DIR}/releases.json"
	# The API pretty-prints one field per line in a fixed order (tag_name,
	# then draft, then prerelease), which is all this needs; no jq required.
	VERSION="$(awk '
		/^ *"tag_name":/ { tag = $0; sub(/.*"tag_name": *"/, "", tag); sub(/".*/, "", tag) }
		/^ *"draft": *true/ { tag = "" }
		/^ *"prerelease": *false/ && tag ~ /^cli-v/ { print substr(tag, 6); exit }
		/^ *"prerelease":/ { tag = "" }
	' "${WORK_DIR}/releases.json")"
	[ -n "$VERSION" ] || die "no published CLI release found; pass --version"
}

# find_openssl picks an OpenSSL 3 binary: macOS ships LibreSSL as `openssl`,
# which cannot verify raw Ed25519 signatures, so Homebrew's is tried too.
find_openssl() {
	for candidate in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
		if command -v "$candidate" >/dev/null 2>&1 &&
			"$candidate" version 2>/dev/null | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9])\.'; then
			OPENSSL="$candidate"
			return 0
		fi
	done
	return 1
}

verify_signature() {
	case "$RELEASE_PUBLIC_KEYS_PEM" in
	*"$PLACEHOLDER_KEY_DER_B64"*)
		die "this copy of install-cli.sh has no release signing key yet, so the download cannot be verified; check SHA256SUMS by hand or pass --insecure-skip-signature"
		;;
	esac
	find_openssl || die "verifying the release signature needs OpenSSL 3 (macOS: brew install openssl@3); or pass --insecure-skip-signature"

	count="$(printf '%s\n' "$RELEASE_PUBLIC_KEYS_PEM" | awk -v dir="$WORK_DIR" '
		/^-----BEGIN PUBLIC KEY-----$/ { file = sprintf("%s/key-%d.pem", dir, n++) }
		file != "" { print > file }
		/^-----END PUBLIC KEY-----$/ { close(file); file = "" }
		END { print n + 0 }
	')"
	[ "$count" -gt 0 ] || die "no release public key embedded in this installer"
	# SECURITY: SHA256SUMS is trusted only after its Ed25519 signature
	# verifies against a pinned key; the archive only through SHA256SUMS.
	i=0
	while [ "$i" -lt "$count" ]; do
		if "$OPENSSL" pkeyutl -verify -pubin -inkey "${WORK_DIR}/key-${i}.pem" -rawin \
			-in "${WORK_DIR}/SHA256SUMS" -sigfile "${WORK_DIR}/SHA256SUMS.sig" >/dev/null 2>&1; then
			return 0
		fi
		i=$((i + 1))
	done
	die "SHA256SUMS signature verification failed; refusing to install"
}

download_and_verify() {
	ASSET="roundhouse-${OS}-${ARCH}.tar.gz"
	base="${DOWNLOAD_BASE}/cli-v${VERSION}"

	log "downloading ${ASSET} (cli-v${VERSION})"
	fetch "${base}/${ASSET}" "${WORK_DIR}/${ASSET}"
	fetch "${base}/SHA256SUMS" "${WORK_DIR}/SHA256SUMS"

	if [ "$SKIP_SIGNATURE" = 1 ]; then
		warn "--insecure-skip-signature: SHA256SUMS is NOT verified; the checksum only catches corrupted downloads"
	else
		fetch "${base}/SHA256SUMS.sig" "${WORK_DIR}/SHA256SUMS.sig"
		verify_signature
	fi

	# SECURITY: the signed version line stops a mirror from serving an older,
	# correctly signed release in place of the one requested.
	signed_version="$(sed -n 's/^# version: //p' "${WORK_DIR}/SHA256SUMS" | head -n 1)"
	[ "$signed_version" = "cli-v${VERSION}" ] ||
		die "requested cli-v${VERSION} but SHA256SUMS is for '${signed_version:-no version}'; refusing to install"

	expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1 }' "${WORK_DIR}/SHA256SUMS")"
	[ -n "$expected" ] || die "${ASSET} is not listed in SHA256SUMS"
	actual="$(sha256_of "${WORK_DIR}/${ASSET}")"
	[ "$expected" = "$actual" ] || die "checksum mismatch for ${ASSET}; refusing to install"
	if [ "$SKIP_SIGNATURE" = 1 ]; then
		log "checksum verified for cli-v${VERSION}"
	else
		log "signature and checksum verified for cli-v${VERSION}"
	fi
}

install_binary() {
	if [ -z "$INSTALL_DIR" ]; then
		if [ "$(id -u)" -eq 0 ]; then
			INSTALL_DIR=/usr/local/bin
		else
			[ -n "${HOME:-}" ] || die "HOME is not set; pass --dir"
			INSTALL_DIR="${HOME}/.local/bin"
		fi
	fi
	mkdir -p "$INSTALL_DIR" || die "cannot create ${INSTALL_DIR}; pass --dir or run with sudo"
	[ -w "$INSTALL_DIR" ] || die "${INSTALL_DIR} is not writable; pass --dir or run with sudo"

	tar -xzf "${WORK_DIR}/${ASSET}" -C "$WORK_DIR" roundhouse
	# Copy then rename, so a running `roundhouse` is never left half-written.
	cp "${WORK_DIR}/roundhouse" "${INSTALL_DIR}/.roundhouse.new.$$"
	chmod 0755 "${INSTALL_DIR}/.roundhouse.new.$$"
	mv -f "${INSTALL_DIR}/.roundhouse.new.$$" "${INSTALL_DIR}/roundhouse"
	log "installed $("${INSTALL_DIR}/roundhouse" --version 2>/dev/null || echo roundhouse) to ${INSTALL_DIR}/roundhouse"

	case ":${PATH}:" in
	*":${INSTALL_DIR}:"*) ;;
	*) warn "${INSTALL_DIR} is not on your PATH; add it, e.g. export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
	esac
}

main() {
	parse_args "$@"
	detect_platform
	command -v tar >/dev/null 2>&1 || die "tar is required"
	WORK_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t roundhouse-cli)"
	trap 'rm -rf "$WORK_DIR"' EXIT
	trap 'exit 130' INT TERM
	[ -n "$VERSION" ] || resolve_latest
	download_and_verify
	install_binary
}

# NOTE: ROUNDHOUSE_INSTALL_SOURCE_ONLY=1 makes sourcing this script define
# its functions without running anything, for tests.
if [ "${ROUNDHOUSE_INSTALL_SOURCE_ONLY:-0}" != 1 ]; then
	main "$@"
fi
