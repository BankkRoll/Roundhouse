#!/usr/bin/env bash
#
# Runs the builder's integration tests (build tag "integration") inside a
# Linux container against the host's Docker Engine.
#
#   agent/internal/builder/testdata/integration.sh [go test flags...]
#
# The container joins the engine's host network, so the test process, the
# registry it starts and sys_buildkitd's gateway all share one loopback, as
# they do on a builder node. Works from Linux and from Git Bash on Windows
# with Docker Desktop. Set OPENRAIL_IT_KEEP=1 to leave sys_buildkitd and the
# registry running afterwards.

set -euo pipefail

GO_IMAGE="golang:1.26.10-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af"
RAILPACK_VERSION=0.43.0
RAILPACK_SHA256_AMD64=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb
RAILPACK_SHA256_ARM64=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && { pwd -W 2>/dev/null || pwd; })"

# NOTE: Git Bash rewrites arguments that look like POSIX paths; the doubled
# leading slash and MSYS_NO_PATHCONV keep the socket and mount paths intact.
export MSYS_NO_PATHCONV=1

docker run --rm --network host \
	-v //var/run/docker.sock:/var/run/docker.sock \
	-v "${repo_root}:/src" \
	-v openrail-it-gomod:/go/pkg/mod \
	-v openrail-it-gocache:/root/.cache/go-build \
	-e OPENRAIL_IT_KEEP="${OPENRAIL_IT_KEEP:-}" \
	-e RAILPACK_VERSION="$RAILPACK_VERSION" \
	-e RAILPACK_SHA256_AMD64="$RAILPACK_SHA256_AMD64" \
	-e RAILPACK_SHA256_ARM64="$RAILPACK_SHA256_ARM64" \
	-w /src/agent \
	"$GO_IMAGE" \
	bash -euo pipefail -c '
		case "$(dpkg --print-architecture)" in
		amd64) triple=x86_64-unknown-linux-musl; sum="$RAILPACK_SHA256_AMD64" ;;
		arm64) triple=arm64-unknown-linux-musl; sum="$RAILPACK_SHA256_ARM64" ;;
		esac
		asset="railpack-v${RAILPACK_VERSION}-${triple}.tar.gz"
		curl -fsSL --proto "=https" -o "/tmp/${asset}" \
			"https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${asset}"
		echo "${sum}  /tmp/${asset}" | sha256sum -c --quiet -
		tar -xzf "/tmp/${asset}" -C /usr/local/bin railpack
		railpack --version
		git config --global --add safe.directory "*"
		go test -tags integration -count=1 -timeout 30m "$@" ./internal/builder/
	' bash "$@"
