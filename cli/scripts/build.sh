#!/usr/bin/env bash
# Cross-compiles the roundhouse CLI and writes SHA256SUMS next to the
# binaries. No goreleaser: plain `go build` per target.
#
#   cli/scripts/build.sh                  # every target into cli/dist
#   VERSION=1.2.0 cli/scripts/build.sh    # stamp an explicit version
#   TARGETS="linux/amd64" OUT_DIR=/tmp/rh cli/scripts/build.sh
#   ARCHIVE=1 cli/scripts/build.sh        # release layout (see below)
#
# The version defaults to the newest `cli-v*` tag (git describe), else "dev".
#
# With ARCHIVE=1 each binary is packed with LICENSE.md and the CLI README as
# roundhouse-<os>-<arch>.tar.gz (.zip for Windows), the bare binaries are
# removed, and SHA256SUMS covers the archives. This is what
# .github/workflows/release-cli.yml publishes. Archives are reproducible:
# entries are in a fixed order, owned by 0:0 and dated SOURCE_DATE_EPOCH
# (default: the commit time), so the same commit and Go toolchain give the
# same bytes.
# ARCHIVE=1 needs GNU tar and touch, and zip for Windows targets.
set -euo pipefail

cli_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$cli_dir/.." && pwd)"
out_dir="${OUT_DIR:-$cli_dir/dist}"
targets="${TARGETS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64}"
archive="${ARCHIVE:-0}"

if [ -z "${VERSION:-}" ]; then
  VERSION="$(git -C "$cli_dir" describe --tags --match 'cli-v*' --dirty 2>/dev/null || true)"
  VERSION="${VERSION#cli-v}"
  VERSION="${VERSION:-dev}"
fi
COMMIT="${COMMIT:-$(git -C "$cli_dir" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$cli_dir" log -1 --format=%ct 2>/dev/null || echo 0)}"

rm -rf "$out_dir"
mkdir -p "$out_dir"
cd "$cli_dir"
for target in $targets; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  [ "$os" = "windows" ] && ext=".exe"
  bin="roundhouse-$os-$arch$ext"
  echo "building $bin ($VERSION)"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" \
    -o "$out_dir/$bin" ./cmd/roundhouse
done

# package <binary> <os> <arch> writes the release archive for one target.
package() {
  local bin="$1" os="$2" arch="$3" stage name
  stage="$(mktemp -d)"
  name="roundhouse"
  [ "$os" = "windows" ] && name="roundhouse.exe"
  cp "$out_dir/$bin" "$stage/$name"
  cp "$repo_dir/LICENSE.md" "$stage/LICENSE.md"
  cp "$cli_dir/README.md" "$stage/README.md"
  chmod 0755 "$stage/$name"
  chmod 0644 "$stage/LICENSE.md" "$stage/README.md"
  # NOTE: zip stores local wall-clock times, so pin the timezone as well as
  # the timestamp or archives built in different zones differ.
  TZ=UTC touch -d "@$SOURCE_DATE_EPOCH" "$stage"/*
  if [ "$os" = "windows" ]; then
    (cd "$stage" && TZ=UTC zip -X -q -D "$out_dir/roundhouse-$os-$arch.zip" LICENSE.md README.md "$name")
  else
    # NOTE: modes are set explicitly because a checkout on a filesystem
    # without Unix permissions would otherwise ship a non-executable binary.
    tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
      --format=gnu --mode=0644 -cf "$stage.tar" LICENSE.md README.md
    tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
      --format=gnu --mode=0755 -rf "$stage.tar" "$name"
    gzip -n -9 <"$stage.tar" >"$out_dir/roundhouse-$os-$arch.tar.gz"
    rm -f "$stage.tar"
  fi
  rm -rf "$stage" "${out_dir:?}/$bin"
}

if [ "$archive" = 1 ]; then
  for target in $targets; do
    os="${target%/*}"
    arch="${target#*/}"
    ext=""
    [ "$os" = "windows" ] && ext=".exe"
    package "roundhouse-$os-$arch$ext" "$os" "$arch"
  done
fi

cd "$out_dir"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum roundhouse-* > SHA256SUMS
else
  shasum -a 256 roundhouse-* > SHA256SUMS
fi
echo "wrote $out_dir/SHA256SUMS"
cat SHA256SUMS
