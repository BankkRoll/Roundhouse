#!/usr/bin/env bash
# Cross-compiles the roundhouse CLI and writes SHA256SUMS next to the
# binaries. No goreleaser: plain `go build` per target.
#
#   cli/scripts/build.sh                  # every target into cli/dist
#   VERSION=1.2.0 cli/scripts/build.sh    # stamp an explicit version
#   TARGETS="linux/amd64" OUT_DIR=/tmp/rh cli/scripts/build.sh
#
# The version defaults to the newest `cli-v*` tag (git describe), else "dev".
set -euo pipefail

cli_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${OUT_DIR:-$cli_dir/dist}"
targets="${TARGETS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64}"

if [ -z "${VERSION:-}" ]; then
  VERSION="$(git -C "$cli_dir" describe --tags --match 'cli-v*' --dirty 2>/dev/null || true)"
  VERSION="${VERSION#cli-v}"
  VERSION="${VERSION:-dev}"
fi
COMMIT="${COMMIT:-$(git -C "$cli_dir" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"

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

cd "$out_dir"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum roundhouse-* > SHA256SUMS
else
  shasum -a 256 roundhouse-* > SHA256SUMS
fi
echo "wrote $out_dir/SHA256SUMS"
cat SHA256SUMS
