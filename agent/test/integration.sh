#!/usr/bin/env bash
# Runs the agent's Docker integration tests (build tag "integration") inside a
# golang container that shares this machine's Docker socket, so the tests
# reach the containers they start by IP on shared bridge networks, exactly as
# the agent does on a Linux node.
#
# Usage: agent/test/integration.sh [go test flags...]
#   e.g. agent/test/integration.sh -run TestZeroDowntime -v
#
# Works on Linux and on Windows (Git Bash with Docker Desktop).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${GO_IMAGE:-golang:1.26}"
packages=(
	./agent/internal/docker/...
	./agent/internal/firewall/...
	./agent/internal/runtime/...
	./agent/internal/ingress/...
	./agent/internal/logship/...
	./agent/internal/volumes/...
	./agent/internal/dataplane/...
	./agent/internal/backup/...
	./agent/internal/dbquery/...
	./agent/internal/jobs/...
)

src="$repo"
# Bind-mount sources name paths on the daemon's host. Tests that bind
# directories they create (volumes) create them under this path, mounted at
# the same path in the test container; with Docker Desktop it lives in the
# Linux VM.
scratch="/var/lib/roundhouse-it"
socket="/var/run/docker.sock"
case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*)
	# Git Bash rewrites anything that looks like a POSIX path into a Windows
	# one, which breaks the container-side paths below. Turn that off and
	# hand Docker Desktop a Windows path for the bind mount instead.
	export MSYS_NO_PATHCONV=1
	src="$(cd "$repo" && pwd -W)"
	;;
esac

if [ "${1:-}" != "" ]; then
	flags=("$@")
else
	flags=(-count=1)
fi

exec docker run --rm \
	-v "${socket}:/var/run/docker.sock" \
	-v "${src}:/src" \
	-v "${scratch}:${scratch}" \
	-v roundhouse-it-gomod:/go/pkg/mod \
	-v roundhouse-it-gocache:/root/.cache/go-build \
	-w /src \
	-e GOFLAGS=-buildvcs=false \
	-e GOTOOLCHAIN=local \
	"$image" \
	go test -tags integration -timeout 15m "${flags[@]}" "${packages[@]}"
