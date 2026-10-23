#!/usr/bin/env bash
#
# Exercises install/install-cli.sh against a fake release signed with a
# throwaway key, on the host it runs on (Linux or macOS with OpenSSL 3):
#
#   bash install/test/install-cli-test.sh
#
# Downloads are replaced by copies from a local directory, so no network is
# needed. The test asserts that a pinned and a resolved-latest version
# install and run, and that a tampered archive, a signature from an unpinned
# key, a mismatched signed version line and the placeholder key are refused.

set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install-cli.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}
pass() { printf 'ok: %s\n' "$*"; }

# Where the installer's release assets live, per tag.
RELEASES="$WORK/releases"
mkdir -p "$RELEASES"

openssl genpkey -algorithm ed25519 -out "$WORK/release.key" 2>/dev/null
openssl pkey -in "$WORK/release.key" -pubout -out "$WORK/release.pub"
openssl genpkey -algorithm ed25519 -out "$WORK/other.key" 2>/dev/null

# The script under test, with the test key pinned in place of the shipped key,
# and a copy pinned to the discarded placeholder key.
pinned_line="$(sed -n '/^RELEASE_PUBLIC_KEYS_PEM=/{n;p;}' "$SCRIPT")"
test_line="$(sed -n '2p' "$WORK/release.pub")"
sed "s|^${pinned_line}\$|${test_line}|" "$SCRIPT" >"$WORK/install-cli.sh"
grep -q "^${test_line}\$" "$WORK/install-cli.sh" || fail "could not pin the test key"
placeholder_b64="$(sed -n 's/^PLACEHOLDER_KEY_DER_B64="\(.*\)"$/\1/p' "$SCRIPT")"
sed "s|^${pinned_line}\$|${placeholder_b64}|" "$SCRIPT" >"$WORK/placeholder-cli.sh"
grep -q "^${placeholder_b64}\$" "$WORK/placeholder-cli.sh" || fail "could not pin the placeholder key"

platform="$(ROUNDHOUSE_INSTALL_SOURCE_ONLY=1 sh -c '. "$1" && detect_platform && echo "$OS-$ARCH"' sh "$SCRIPT")"

# make_release <version> [signing key] writes a release whose binary prints
# its version.
make_release() {
	local version="$1" key="${2:-$WORK/release.key}" dir="$RELEASES/cli-v$1" stage
	mkdir -p "$dir"
	stage="$(mktemp -d)"
	printf '#!/bin/sh\necho "roundhouse %s (test)"\n' "$version" >"$stage/roundhouse"
	chmod 0755 "$stage/roundhouse"
	tar -C "$stage" -czf "$dir/roundhouse-$platform.tar.gz" roundhouse
	rm -rf "$stage"
	(
		cd "$dir"
		printf '# version: cli-v%s\n' "$version"
		if command -v sha256sum >/dev/null 2>&1; then
			sha256sum "roundhouse-$platform.tar.gz"
		else
			shasum -a 256 "roundhouse-$platform.tar.gz"
		fi
	) >"$dir/SHA256SUMS"
	openssl pkeyutl -sign -rawin -inkey "$key" -in "$dir/SHA256SUMS" -out "$dir/SHA256SUMS.sig"
}

cat >"$RELEASES/releases.json" <<'JSON'
[
  {
    "tag_name": "cli-v0.3.0",
    "draft": true,
    "prerelease": false
  },
  {
    "tag_name": "cli-v0.2.0-rc.1",
    "draft": false,
    "prerelease": true
  },
  {
    "tag_name": "agent-v0.9.0",
    "draft": false,
    "prerelease": false
  },
  {
    "tag_name": "cli-v0.1.0",
    "draft": false,
    "prerelease": false
  }
]
JSON

# run_installer <script> <install dir> [args...] runs the installer with
# fetch() serving files from $RELEASES.
run_installer() {
	local script="$1" dir="$2"
	shift 2
	RELEASES="$RELEASES" ROUNDHOUSE_INSTALL_SOURCE_ONLY=1 sh -c '
		. "$1"
		fetch() {
			case "$1" in
			*/releases\?per_page=*) cp "$RELEASES/releases.json" "$2" ;;
			*) cp "$RELEASES/${1#"$DOWNLOAD_BASE"/}" "$2" ;;
			esac
		}
		shift
		main "$@"
	' sh "$script" --dir "$dir" "$@"
}

expect_refused() {
	local what="$1" pattern="$2"
	shift 2
	local out
	if out="$(run_installer "$@" 2>&1)"; then
		fail "$what: installed, expected a refusal"
	fi
	grep -q "$pattern" <<<"$out" || fail "$what: wrong error: $out"
	pass "$what refused"
}

make_release 0.1.0
make_release 0.0.9

run_installer "$WORK/install-cli.sh" "$WORK/bin-pinned" --version 0.0.9 2>/dev/null
[ "$("$WORK/bin-pinned/roundhouse")" = "roundhouse 0.0.9 (test)" ] || fail "pinned install"
pass "pinned version installs"

run_installer "$WORK/install-cli.sh" "$WORK/bin-latest" 2>/dev/null
[ "$("$WORK/bin-latest/roundhouse")" = "roundhouse 0.1.0 (test)" ] ||
	fail "latest should skip drafts, prereleases and agent releases"
pass "latest resolves to the newest published CLI release"

run_installer "$WORK/install-cli.sh" "$WORK/bin-latest" --version v0.0.9 2>/dev/null
[ "$("$WORK/bin-latest/roundhouse")" = "roundhouse 0.0.9 (test)" ] || fail "re-install over an existing binary"
pass "re-install replaces the binary"

cp "$RELEASES/cli-v0.1.0/SHA256SUMS" "$RELEASES/cli-v0.1.0/SHA256SUMS.good"
cp "$RELEASES/cli-v0.0.9/SHA256SUMS" "$RELEASES/cli-v0.1.0/SHA256SUMS"
cp "$RELEASES/cli-v0.0.9/SHA256SUMS.sig" "$RELEASES/cli-v0.1.0/SHA256SUMS.sig"
expect_refused "older signed checksums under a newer tag" "SHA256SUMS is for 'cli-v0.0.9'" \
	"$WORK/install-cli.sh" "$WORK/bin-x" --version 0.1.0

make_release 0.1.0 "$WORK/other.key"
expect_refused "signature from an unpinned key" "signature verification failed" \
	"$WORK/install-cli.sh" "$WORK/bin-x" --version 0.1.0

make_release 0.1.0
printf 'tampered' >>"$RELEASES/cli-v0.1.0/roundhouse-$platform.tar.gz"
expect_refused "tampered archive" "checksum mismatch" \
	"$WORK/install-cli.sh" "$WORK/bin-x" --version 0.1.0

make_release 0.1.0
expect_refused "placeholder key" "no release signing key yet" \
	"$WORK/placeholder-cli.sh" "$WORK/bin-x" --version 0.1.0
expect_refused "malformed version" "must look like" \
	"$WORK/install-cli.sh" "$WORK/bin-x" --version '../0.1.0'

run_installer "$SCRIPT" "$WORK/bin-skip" --version 0.1.0 --insecure-skip-signature 2>/dev/null
[ "$("$WORK/bin-skip/roundhouse")" = "roundhouse 0.1.0 (test)" ] || fail "--insecure-skip-signature"
pass "--insecure-skip-signature still installs a matching checksum"

[ ! -e "$WORK/bin-x/roundhouse" ] || fail "a refused install left a binary behind"
echo "install-cli.sh: all checks passed"
