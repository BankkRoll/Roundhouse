#!/usr/bin/env bash
#
# Roundhouse node installer.
#
#   curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <JOIN_TOKEN> [options]
#
# Options:
#   --token <t>       Single-use join token from the dashboard.
#   --token-file <p>  Read the join token from a file instead (for cloud-init
#                     and automation). The file is left in place.
#                     With neither option, the token is prompted for on the
#                     terminal when one is available. No token is needed if
#                     this host has already joined.
#   --name <n>        Node display name (default: hostname).
#   --url <u>         Control plane URL (default: the origin that served this
#                     script). Must be https:// unless the host is loopback.
#   --version <v>     Agent version to install, e.g. 0.1.0 (default: the version
#                     the control plane pins, else latest).
#   --rejoin          Re-register even if this host has already joined.
#   --builder         Make this node a builder: it builds images from git with
#                     BuildKit and Railpack and hosts the local registry. Also
#                     installs Railpack and pre-pulls the BuildKit and registry
#                     images, and where AppArmor can restrict unprivileged
#                     user namespaces, loads the roundhouse-buildkit
#                     AppArmor profile rootless BuildKit needs. Chosen at
#                     join time; re-runs on a builder keep it.
#   --binary <p>      DEV ONLY: install a local agent binary, skipping download
#                     and signature verification.
#
# Environment:
#   ROUNDHOUSE_DOWNLOAD_BASE  Release download base
#                           (default: https://github.com/BankkRoll/Roundhouse/releases/download).
#                           Version v is fetched from <base>/agent-v<v>/; "latest"
#                           is fetched from the sibling <base>/../latest/download/,
#                           GitHub's redirect to the newest release, so mirrors must
#                           mimic that layout.
#   ROUNDHOUSE_SKIP_OS_CHECK  Set to 1 to install on an unsupported distribution.
#
# Order of work: the join token is single-use and short-lived, so the agent
# is downloaded and joined first, and only then are Docker and the other slow
# dependencies installed.
#
# Every node gets Docker, git and Caddy (ingress). Caddy is configured only by
# the agent, through its admin API on localhost:2019.
#
# Firewall: Roundhouse needs no inbound port for its control traffic (the agent
# dials out). Allow inbound TCP 80 and 443 (and UDP 443 for HTTP/3) for
# ingress, and keep everything else closed. If ufw is active, the installer
# adds those rules itself.
#
# Safe to re-run: packages already present are kept, the binary and systemd
# unit are replaced, and an already-joined host is not re-registered.

set -euo pipefail

# NOTE: the control plane rewrites these placeholders when serving the
# script: the URL to its own origin, the version to the agent release it
# pins. Unsubstituted, the URL must be passed with --url and the version
# falls back to latest.
CONTROL_PLANE_URL="__CONTROL_PLANE_URL__"
PINNED_AGENT_VERSION="__AGENT_VERSION__"

# IMPORTANT: release-signing public keys, one PEM block each, verbatim as
# `openssl pkey -pubout` prints them. SHA256SUMS is accepted if any of them
# verifies it, which lets a rotation ship the next key before it is used (see
# infra/release-signing.md). PLACEHOLDER_KEY_DER_B64 is the discarded
# placeholder key; while it is pinned, downloads are refused and only
# --binary works.
RELEASE_PUBLIC_KEYS_PEM="$(
	cat <<'PEM'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAL/QmFCAOLoDncNOA7WnG9SahMbrXfSz2O1PWiqXw8Qc=
-----END PUBLIC KEY-----
PEM
)"
PLACEHOLDER_KEY_DER_B64="MCowBQYDK2VwAyEAkHLBdd+mLYOoixvDbr8za3PLXSGyGu4wFPf5jmAiK88="

DOWNLOAD_BASE="${ROUNDHOUSE_DOWNLOAD_BASE:-https://github.com/BankkRoll/Roundhouse/releases/download}"
BIN_PATH=/usr/local/bin/roundhouse-agent
CONFIG_PATH=/etc/roundhouse/agent.yaml
UNIT_PATH=/etc/systemd/system/roundhouse-agent.service
APT_GET=(apt-get -o DPkg::Lock::Timeout=300)

MIN_CPUS=1
# NOTE: a "1 GiB" VM reports ~950 MiB in MemTotal after kernel reservations,
# so the floor sits below the advertised requirement.
MIN_MEM_KIB=$((900 * 1024))
MIN_DISK_KIB=$((10 * 1024 * 1024))
# Builders also hold BuildKit's cache (capped at 20 GiB, with GC) and the
# registry.
MIN_BUILDER_DISK_KIB=$((20 * 1024 * 1024))

# Caddy comes from its official Cloudsmith apt repository. The repository key
# is trusted only if its primary key fingerprint matches.
CADDY_KEY_URL="https://dl.cloudsmith.io/public/caddy/stable/gpg.key"
CADDY_KEY_FINGERPRINT="65760C51EDEA2017CEA2CA15155B6D79CA56EA34"
CADDY_REPO="https://dl.cloudsmith.io/public/caddy/stable/deb/debian"
CADDY_KEYRING=/etc/apt/keyrings/caddy-stable.asc
CADDY_LIST=/etc/apt/sources.list.d/caddy-stable.list
CADDY_DROPIN=/etc/systemd/system/caddy.service.d/roundhouse.conf
# Must match certs.DefaultDir in agent/internal/certs.
CERTS_DIR=/var/lib/roundhouse-certs

# IMPORTANT: builder pins. The Railpack CLI version must match the frontend
# image the agent builds with, and the image references must match the
# agent's (agent/internal/builder); a Go test fails if they drift.
RAILPACK_VERSION=0.43.0
RAILPACK_SHA256_AMD64=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb
RAILPACK_SHA256_ARM64=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9
RAILPACK_BIN=/usr/local/bin/railpack
BUILDKIT_IMAGE="moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89"
REGISTRY_IMAGE="registry:3.1.2@sha256:01cd312e67026f06f5d89c3e133a4a9adc7cb9eeb9b1194e0b2954dfd770efd2"
# The build network's bridge and the agent's per-build registry proxy port,
# which BuildKit's container must reach on the host.
BUILD_BRIDGE=roundhouse-bk0
REGISTRY_PROXY_PORT=5001

# Where AppArmor restricts unprivileged user namespaces (Ubuntu 23.10 and
# later), rootless BuildKit can start only under this profile, which grants
# it `userns` and nothing else; the agent uses it once it is loaded. Its
# source is install/roundhouse-buildkit.apparmor. The host-wide restriction
# is left as the distribution set it.
BUILDKIT_APPARMOR_PROFILE=roundhouse-buildkit
BUILDKIT_APPARMOR_FILE=/etc/apparmor.d/roundhouse-buildkit
APPARMOR_ENABLED=/sys/module/apparmor/parameters/enabled
APPARMOR_FS=/sys/kernel/security/apparmor
USERNS_RESTRICT_SYSCTL=/proc/sys/kernel/apparmor_restrict_unprivileged_userns

# NOTE: these globals must not share names with /etc/os-release variables
# (NAME, VERSION, ID, ...); os-release is only ever read in a subshell.
TOKEN=""
TOKEN_FILE=""
NODE_NAME=""
AGENT_VERSION=""
LOCAL_BINARY=""
REJOIN=0
BUILDER=0
URL="$CONTROL_PLANE_URL"
WORK_DIR=""
JOINED_THIS_RUN=0
OS_ID=""
OS_VER=""
OS_CODENAME=""
OS_PRETTY=""

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: install.sh [--token <JOIN_TOKEN> | --token-file <path>] [--name <n>] [--url <u>]
                  [--version <v>] [--rejoin] [--builder] [--binary <path>]

See the header of this script for details.
EOF
	exit "${1:-0}"
}

on_exit() {
	local status=$?
	if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
		if [ -f "${WORK_DIR}/token" ]; then
			shred -u "${WORK_DIR}/token" 2>/dev/null || rm -f "${WORK_DIR}/token"
		fi
		rm -rf "$WORK_DIR"
	fi
	if [ "$status" -ne 0 ] && [ "$JOINED_THIS_RUN" = 1 ]; then
		printf '\033[1;31merror:\033[0m this host has already joined; re-run install.sh (no token needed) to finish setup\n' >&2
	fi
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--token) TOKEN="${2:?--token needs a value}"; shift 2 ;;
		--token-file) TOKEN_FILE="${2:?--token-file needs a value}"; shift 2 ;;
		--name) NODE_NAME="${2:?--name needs a value}"; shift 2 ;;
		--url) URL="${2:?--url needs a value}"; shift 2 ;;
		--version) AGENT_VERSION="${2:?--version needs a value}"; shift 2 ;;
		--binary) LOCAL_BINARY="${2:?--binary needs a value}"; shift 2 ;;
		--rejoin) REJOIN=1; shift ;;
		--builder) BUILDER=1; shift ;;
		-h | --help) usage 0 ;;
		*) die "unknown option: $1 (see --help)" ;;
		esac
	done

	if [ -n "$TOKEN" ] && [ -n "$TOKEN_FILE" ]; then
		die "pass only one of --token and --token-file"
	fi
	# NOTE: built by concatenation so the control plane's substitution, which
	# rewrites every literal occurrence, cannot also rewrite these checks.
	local url_placeholder="__CONTROL_PLANE""_URL__"
	local version_placeholder="__AGENT""_VERSION__"
	if [ "$URL" = "$url_placeholder" ] || [ -z "$URL" ]; then
		die "no control plane URL; pass --url https://<your-control-plane>"
	fi
	URL="${URL%/}"
	check_url

	if [ -z "$AGENT_VERSION" ]; then
		AGENT_VERSION="$PINNED_AGENT_VERSION"
		if [ -z "$AGENT_VERSION" ] || [ "$AGENT_VERSION" = "$version_placeholder" ]; then
			AGENT_VERSION=latest
		fi
	fi
	AGENT_VERSION="${AGENT_VERSION#agent-}"
	AGENT_VERSION="${AGENT_VERSION#v}"
	[[ "$AGENT_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] ||
		die "invalid --version ${AGENT_VERSION}"
}

# url_host prints the host of an http(s) URL, without brackets or port.
url_host() {
	local rest="${1#*://}"
	rest="${rest%%[/?#]*}"
	rest="${rest##*@}"
	case "$rest" in
	\[*) rest="${rest#\[}"; printf '%s\n' "${rest%%\]*}" ;;
	*) printf '%s\n' "${rest%%:*}" ;;
	esac
}

is_loopback() {
	case "$1" in
	localhost | 127.[0-9]* | ::1) return 0 ;;
	*) return 1 ;;
	esac
}

check_url() {
	case "$URL" in
	https://*) ;;
	http://*)
		# SECURITY: plaintext would expose the join token and node credential.
		is_loopback "$(url_host "$URL")" ||
			die "refusing plaintext control plane URL ${URL}; use https://"
		;;
	*) die "control plane URL must start with https://, got ${URL}" ;;
	esac
}

# fetch downloads $1 to $2. https is enforced for every hop, including
# redirects; plain http is allowed only to loopback for local development.
fetch() {
	local url="$1" out="$2"
	case "$url" in
	https://*) curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$out" "$url" ;;
	http://*)
		is_loopback "$(url_host "$url")" || die "refusing to download over plaintext: ${url}"
		curl -fsSL --retry 3 -o "$out" "$url"
		;;
	*) die "unsupported download URL: ${url}" ;;
	esac
}

require_root() {
	[ "$(id -u)" -eq 0 ] || die "must run as root (pipe into 'sudo bash')"
}

check_os() {
	[ -r /etc/os-release ] || die "cannot read /etc/os-release"
	# NOTE: sourced in a subshell; os-release defines NAME, VERSION and ID,
	# which must not leak into this script.
	eval "$(
		# shellcheck disable=SC1091
		. /etc/os-release
		printf 'OS_ID=%q OS_VER=%q OS_CODENAME=%q OS_PRETTY=%q\n' \
			"${ID:-}" "${VERSION_ID:-}" "${VERSION_CODENAME:-}" "${PRETTY_NAME:-${ID:-unknown}}"
	)"
	case "${OS_ID}:${OS_VER}" in
	ubuntu:22.04 | ubuntu:24.04 | debian:12) ;;
	*)
		if [ "${ROUNDHOUSE_SKIP_OS_CHECK:-0}" = 1 ]; then
			warn "unsupported OS ${OS_PRETTY}; continuing because ROUNDHOUSE_SKIP_OS_CHECK=1"
		else
			die "unsupported OS ${OS_PRETTY}: Roundhouse supports Ubuntu 22.04, Ubuntu 24.04 and Debian 12"
		fi
		;;
	esac
	[ -n "$OS_CODENAME" ] || die "VERSION_CODENAME missing from /etc/os-release"
	command -v apt-get >/dev/null || die "apt-get not found"
	command -v systemctl >/dev/null || die "systemd is required"
}

check_arch() {
	case "$(uname -m)" in
	x86_64 | amd64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die "unsupported architecture $(uname -m): Roundhouse supports x86_64 and aarch64" ;;
	esac
}

check_resources() {
	local cpus mem_kib disk_kib
	cpus="$(nproc)"
	mem_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"

	[ "$cpus" -ge "$MIN_CPUS" ] || die "need at least ${MIN_CPUS} vCPU, found ${cpus}"
	[ "$mem_kib" -ge "$MIN_MEM_KIB" ] ||
		die "need at least 1 GiB RAM, found $((mem_kib / 1024)) MiB"

	if already_joined; then
		log "resources OK: ${cpus} vCPU, $((mem_kib / 1024)) MiB RAM (disk check skipped, already joined)"
		return
	fi
	# Docker images and volumes land under /var/lib.
	local min_kib="$MIN_DISK_KIB"
	if [ "$BUILDER" = 1 ]; then min_kib="$MIN_BUILDER_DISK_KIB"; fi
	disk_kib="$(df -Pk /var/lib | awk 'NR == 2 { print $4 }')"
	[ "$disk_kib" -ge "$min_kib" ] ||
		die "need at least $((min_kib / 1024 / 1024)) GiB free disk on /var/lib, found $((disk_kib / 1024 / 1024)) GiB"
	log "resources OK: ${cpus} vCPU, $((mem_kib / 1024)) MiB RAM, $((disk_kib / 1024 / 1024)) GiB free"
}

joined_as_builder() {
	already_joined && grep -Eq '^builder: *true *$' "$CONFIG_PATH"
}

# check_builder_role settles whether this is a builder node before the join
# token is spent. The role is fixed at join time and recorded in the agent's
# config, so re-runs keep it without --builder.
check_builder_role() {
	if joined_as_builder; then
		BUILDER=1
		return
	fi
	if [ "$BUILDER" = 1 ] && already_joined && [ "$REJOIN" != 1 ]; then
		die "this host joined as a non-builder node; to make it a builder, re-run with --rejoin --builder and a new join token"
	fi
}

# check_docker_flavour refuses Docker installs the agent cannot drive, before
# the join token is spent.
check_docker_flavour() {
	local docker_bin
	docker_bin="$(command -v docker || true)"
	[ -n "$docker_bin" ] || return 0
	case "$(readlink -f "$docker_bin")" in
	/snap/*) die "Docker is installed as a snap, which Roundhouse does not support; run 'snap remove docker' and re-run this script" ;;
	esac
	if dpkg -s podman-docker >/dev/null 2>&1 || docker --version 2>/dev/null | grep -qi podman; then
		die "'docker' is provided by Podman (podman-docker), which Roundhouse does not support; remove podman-docker and re-run this script"
	fi
}

wait_for_cloud_init() {
	command -v cloud-init >/dev/null || return 0
	log "waiting for cloud-init to finish"
	cloud-init status --wait >/dev/null 2>&1 || warn "cloud-init reported an error; continuing"
}

apt_update() {
	DEBIAN_FRONTEND=noninteractive "${APT_GET[@]}" update -qq
}

apt_install() {
	DEBIAN_FRONTEND=noninteractive "${APT_GET[@]}" install -y -qq --no-install-recommends "$@" >/dev/null
}

# install_prereqs installs only what downloading and verifying the agent
# needs, and only if it is missing, so the join is not delayed.
install_prereqs() {
	local missing=()
	command -v curl >/dev/null || missing+=(curl)
	command -v openssl >/dev/null || missing+=(openssl)
	[ -s /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
	if [ ${#missing[@]} -gt 0 ]; then
		log "installing prerequisites: ${missing[*]}"
		apt_update
		apt_install "${missing[@]}"
	fi
}

already_joined() {
	[ -f "$CONFIG_PATH" ] && grep -Eq '^node_id: *[^[:space:]"'\'']' "$CONFIG_PATH"
}

needs_join() {
	! already_joined || [ "$REJOIN" = 1 ]
}

# acquire_token resolves the join token before anything slow happens, so a
# missing token fails fast and a prompted token is used promptly.
acquire_token() {
	needs_join || return 0
	if [ -n "$TOKEN_FILE" ]; then
		[ -s "$TOKEN_FILE" ] || die "--token-file: ${TOKEN_FILE} is missing or empty"
		return 0
	fi
	if [ -z "$TOKEN" ] && { : </dev/tty; } 2>/dev/null; then
		printf 'Roundhouse join token: ' >/dev/tty
		IFS= read -rs TOKEN </dev/tty || true
		printf '\n' >/dev/tty
	fi
	[ -n "$TOKEN" ] || die "a join token is required: pass --token or --token-file"

	# SECURITY: the agent reads the token from a 0600 file rather than its
	# command line, so it is not copied into another process's argv. A
	# --token given to this script stays visible in this script's own argv
	# until it exits; that is acceptable only because the token is
	# single-use and is consumed by the join before the slow steps run.
	(umask 077 && printf '%s\n' "$TOKEN" >"${WORK_DIR}/token")
	TOKEN=""
	TOKEN_FILE="${WORK_DIR}/token"
}

# write_release_keys splits the pinned PEM blocks into key-0.pem, key-1.pem,
# ... in $1 and prints how many it wrote.
write_release_keys() {
	printf '%s\n' "$RELEASE_PUBLIC_KEYS_PEM" | awk -v dir="$1" '
		/^-----BEGIN PUBLIC KEY-----$/ { file = sprintf("%s/key-%d.pem", dir, n++) }
		file != "" { print > file }
		/^-----END PUBLIC KEY-----$/ { close(file); file = "" }
		END { print n + 0 }
	'
}

download_agent() {
	local dir="$1" asset="roundhouse-agent-linux-${ARCH}" base
	if [[ "$RELEASE_PUBLIC_KEYS_PEM" == *"$PLACEHOLDER_KEY_DER_B64"* ]]; then
		die "this installer has no release signing key yet, so downloads cannot be verified; use --binary <path> for development"
	fi
	if [ "$AGENT_VERSION" = latest ]; then
		base="${DOWNLOAD_BASE%/download}/latest/download"
	else
		base="${DOWNLOAD_BASE}/agent-v${AGENT_VERSION}"
	fi

	log "downloading ${asset} (${AGENT_VERSION})"
	fetch "${base}/${asset}" "${dir}/${asset}"
	fetch "${base}/SHA256SUMS" "${dir}/SHA256SUMS"
	fetch "${base}/SHA256SUMS.sig" "${dir}/SHA256SUMS.sig"

	# SECURITY: the checksum file is trusted only after its Ed25519 signature
	# verifies against one of the keys embedded above; the binary is trusted
	# only via that checksum. SHA256SUMS.sig is the raw 64-byte signature.
	local count i verified=0
	count="$(write_release_keys "$dir")"
	[ "$count" -gt 0 ] || die "no release public key embedded in this installer"
	for ((i = 0; i < count; i++)); do
		if openssl pkeyutl -verify -pubin -inkey "${dir}/key-${i}.pem" -rawin \
			-in "${dir}/SHA256SUMS" -sigfile "${dir}/SHA256SUMS.sig" >/dev/null 2>&1; then
			verified=1
			break
		fi
	done
	[ "$verified" = 1 ] || die "SHA256SUMS signature verification failed; refusing to install"

	# SECURITY: the signed version line stops a mirror from serving an older,
	# correctly signed release in place of the one requested.
	local signed_version
	signed_version="$(sed -n 's/^# version: //p' "${dir}/SHA256SUMS" | head -n 1)"
	[ -n "$signed_version" ] || die "SHA256SUMS has no signed version line; refusing to install"
	if [ "$AGENT_VERSION" != latest ] && [ "$signed_version" != "agent-v${AGENT_VERSION}" ]; then
		die "requested agent-v${AGENT_VERSION} but the signed checksums are for ${signed_version}; refusing to install"
	fi

	local expected
	expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "${dir}/SHA256SUMS")"
	[ -n "$expected" ] || die "${asset} not listed in SHA256SUMS"
	printf '%s  %s\n' "$expected" "${dir}/${asset}" | sha256sum -c --quiet - ||
		die "checksum mismatch for ${asset}; refusing to install"
	log "signature and checksum verified for ${signed_version}"

	AGENT_SRC="${dir}/${asset}"
}

install_agent() {
	if [ -n "$LOCAL_BINARY" ]; then
		[ -f "$LOCAL_BINARY" ] || die "--binary: no such file: $LOCAL_BINARY"
		warn "############################################################"
		warn "# --binary: installing ${LOCAL_BINARY} WITHOUT verification #"
		warn "# This is for development only. Never use it in production. #"
		warn "############################################################"
		AGENT_SRC="$LOCAL_BINARY"
	else
		download_agent "$WORK_DIR"
	fi

	install -m 0755 "$AGENT_SRC" "${BIN_PATH}.new"
	mv -f "${BIN_PATH}.new" "$BIN_PATH"
	log "installed $("$BIN_PATH" version) to ${BIN_PATH}"
}

join_control_plane() {
	if ! needs_join; then
		log "already joined ($(grep -E '^node_id:' "$CONFIG_PATH")); pass --rejoin to register again"
		return
	fi

	local args=(join --url "$URL" --config "$CONFIG_PATH" --token-file "$TOKEN_FILE")
	if [ -n "$NODE_NAME" ]; then args+=(--name "$NODE_NAME"); fi
	if [ "$REJOIN" = 1 ]; then args+=(--force); fi
	if [ "$BUILDER" = 1 ]; then args+=(--builder); fi

	log "joining ${URL}"
	"$BIN_PATH" "${args[@]}"
	JOINED_THIS_RUN=1
	if [ "$TOKEN_FILE" = "${WORK_DIR}/token" ]; then
		shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"
	fi
}

install_packages() {
	log "installing node dependencies"
	apt_update
	# gpg verifies the Caddy repository key; git fetches sources on builders.
	apt_install wireguard-tools git ca-certificates gpg

	if command -v docker >/dev/null; then
		log "Docker already installed ($(docker --version 2>/dev/null || echo unknown version))"
	else
		log "installing Docker Engine from download.docker.com"
		install -m 0755 -d /etc/apt/keyrings
		fetch "https://download.docker.com/linux/${OS_ID}/gpg" /etc/apt/keyrings/docker.asc
		chmod a+r /etc/apt/keyrings/docker.asc
		printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
			"$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" >/etc/apt/sources.list.d/docker.list
		apt_update
		apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin
	fi
	systemctl enable --now docker >/dev/null

	install_caddy
	if [ "$BUILDER" = 1 ]; then
		if apparmor_mediates_userns && [ -d "$APPARMOR_FS" ] && ! command -v apparmor_parser >/dev/null; then
			log "installing apparmor (apparmor_parser) for the BuildKit profile"
			apt_install apparmor
		fi
		install_buildkit_apparmor
		install_railpack
		prepull_builder_images
	fi
	# TODO(phase-2): install gVisor (runsc) and register it as a Docker runtime.
}

# install_caddy installs Caddy from its official apt repository and runs it
# with no configuration of its own: the agent owns the config and pushes it
# through the admin API, which listens on localhost only.
install_caddy() {
	local key="${WORK_DIR}/caddy.asc" gnupg="${WORK_DIR}/gnupg" fpr
	fetch "$CADDY_KEY_URL" "$key"
	# SECURITY: the key is trusted only if its primary fingerprint is the one
	# pinned above; the signed repository metadata then vouches for the
	# packages.
	mkdir -m 0700 "$gnupg"
	fpr="$(GNUPGHOME="$gnupg" gpg --batch --quiet --show-keys --with-colons "$key" 2>/dev/null |
		awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; exit }')"
	[ "$fpr" = "$CADDY_KEY_FINGERPRINT" ] ||
		die "Caddy repository key fingerprint is ${fpr:-unreadable}, expected ${CADDY_KEY_FINGERPRINT}; refusing to install"

	install -m 0755 -d /etc/apt/keyrings
	install -m 0644 "$key" "$CADDY_KEYRING"
	local list
	list="$(printf 'deb [signed-by=%s] %s any-version main' "$CADDY_KEYRING" "$CADDY_REPO")"
	if [ ! -f "$CADDY_LIST" ] || [ "$(cat "$CADDY_LIST")" != "$list" ]; then
		printf '%s\n' "$list" >"$CADDY_LIST"
		apt_update
	fi
	if command -v caddy >/dev/null && dpkg -s caddy >/dev/null 2>&1; then
		log "Caddy already installed ($(caddy version 2>/dev/null | awk '{ print $1 }'))"
	else
		log "installing Caddy from the official Cloudsmith repository"
		apt_install caddy
	fi

	# NOTE: the agent writes the control plane's certificates (managed TLS
	# mode) here as 0640 files. The setgid bit makes them group caddy without
	# the agent needing CAP_CHOWN, and its unit's RestrictSUIDSGID forbids it
	# from setting that bit itself, so the installer does. Re-running fixes
	# the owner and mode.
	if getent group caddy >/dev/null; then
		install -d -m 2750 -o root -g caddy "$CERTS_DIR"
	else
		warn "no caddy group; ${CERTS_DIR} is root-only, so Caddy must run as root to load managed certificates"
		install -d -m 0700 -o root -g root "$CERTS_DIR"
	fi

	# NOTE: --resume starts from the config the agent last pushed (Caddy
	# autosaves it), or from an empty config on first start, instead of the
	# packaged Caddyfile. Reload is disabled because it would replace the
	# agent's config with that Caddyfile.
	local dropin
	dropin="$(
		cat <<'CADDY'
# Managed by the Roundhouse installer. roundhouse-agent configures Caddy through
# its admin API; the packaged Caddyfile is not used.
[Service]
Environment=CADDY_ADMIN=localhost:2019
ExecStart=
ExecStart=/usr/bin/caddy run --environ --resume
ExecReload=
CADDY
	)"
	local changed=0
	if [ ! -f "$CADDY_DROPIN" ] || [ "$(cat "$CADDY_DROPIN")" != "$dropin" ]; then
		install -m 0755 -d "$(dirname "$CADDY_DROPIN")"
		printf '%s\n' "$dropin" >"$CADDY_DROPIN"
		changed=1
	fi
	systemctl daemon-reload
	systemctl enable caddy.service >/dev/null
	# NOTE: restarting drops in-flight requests, so only a changed drop-in
	# restarts a running Caddy.
	if [ "$changed" = 1 ]; then
		systemctl restart caddy.service
	else
		systemctl start caddy.service
	fi
}

# install_railpack installs the pinned Railpack CLI, which plans builds on
# builder nodes, after checking its sha256.
install_railpack() {
	local current="" triple sum asset
	if [ -x "$RAILPACK_BIN" ]; then
		current="$("$RAILPACK_BIN" --version 2>/dev/null | awk '{ print $NF }')"
	fi
	if [ "$current" = "$RAILPACK_VERSION" ]; then
		log "Railpack ${RAILPACK_VERSION} already installed"
		return
	fi
	case "$ARCH" in
	amd64) triple=x86_64-unknown-linux-musl sum="$RAILPACK_SHA256_AMD64" ;;
	arm64) triple=arm64-unknown-linux-musl sum="$RAILPACK_SHA256_ARM64" ;;
	esac
	asset="railpack-v${RAILPACK_VERSION}-${triple}.tar.gz"
	log "installing Railpack ${RAILPACK_VERSION}"
	fetch "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${asset}" "${WORK_DIR}/${asset}"
	printf '%s  %s\n' "$sum" "${WORK_DIR}/${asset}" | sha256sum -c --quiet - ||
		die "checksum mismatch for ${asset}; refusing to install"
	mkdir -p "${WORK_DIR}/railpack"
	tar -xzf "${WORK_DIR}/${asset}" -C "${WORK_DIR}/railpack" railpack
	install -m 0755 "${WORK_DIR}/railpack/railpack" "${RAILPACK_BIN}.new"
	mv -f "${RAILPACK_BIN}.new" "$RAILPACK_BIN"
}

# userns_restricted reports whether AppArmor restricts unprivileged user
# namespaces right now.
userns_restricted() {
	[ "$(cat "$USERNS_RESTRICT_SYSCTL" 2>/dev/null)" = 1 ]
}

# apparmor_mediates_userns reports whether AppArmor is active and this
# kernel lets it mediate user namespace creation, which is when a profile's
# `userns` rule matters. The restriction's current value is ignored: it can
# be switched on at any time, and the profile is harmless while it is off.
apparmor_mediates_userns() {
	[ "$(cat "$APPARMOR_ENABLED" 2>/dev/null)" = Y ] || return 1
	[ -e "$USERNS_RESTRICT_SYSCTL" ] || [ -e "${APPARMOR_FS}/features/namespaces/userns_create" ]
}

# install_buildkit_apparmor writes and loads the BuildKit AppArmor profile
# where the kernel can restrict user namespaces. A failure is fatal only
# while the restriction is on, because only then can BuildKit not start
# without the profile.
install_buildkit_apparmor() {
	apparmor_mediates_userns || return 0
	if [ ! -d "$APPARMOR_FS" ]; then
		# NOTE: securityfs is not mounted inside containers, so policy cannot
		# be loaded from one; whoever runs the host must load the profile.
		warn "AppArmor's policy interface (${APPARMOR_FS}) is not mounted, so the ${BUILDKIT_APPARMOR_PROFILE} profile was not loaded; if kernel.apparmor_restrict_unprivileged_userns=1 on the host, load install/roundhouse-buildkit.apparmor there or BuildKit cannot start"
		return 0
	fi

	local failure="" out profile
	profile="$(
		cat <<'APPARMOR'
# Managed by the Roundhouse installer; rewritten on every run.
#
# Lets rootless BuildKit (sys_buildkitd on builder nodes) create its user
# namespace on hosts with kernel.apparmor_restrict_unprivileged_userns=1,
# without lifting that restriction for the rest of the host. The profile
# attaches to no executable: only a container started with
# --security-opt apparmor=roundhouse-buildkit runs under it. Apart from the
# userns rule it is unconfined, like the apparmor=unconfined that BuildKit
# documents for rootless containers.

abi <abi/4.0>,

include <tunables/global>

profile roundhouse-buildkit flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/roundhouse-buildkit>
}
APPARMOR
	)"
	if ! command -v apparmor_parser >/dev/null; then
		failure="apparmor_parser is not installed (apt-get install apparmor)"
	else
		install -m 0755 -d "$(dirname "$BUILDKIT_APPARMOR_FILE")"
		if [ ! -f "$BUILDKIT_APPARMOR_FILE" ] || [ "$(cat "$BUILDKIT_APPARMOR_FILE")" != "$profile" ]; then
			(umask 022 && printf '%s\n' "$profile" >"$BUILDKIT_APPARMOR_FILE")
		fi
		# NOTE: loaded even when the file is unchanged, since it can be on
		# disk but not in the kernel (after aa-teardown, or when this host
		# gained AppArmor since the last run).
		if out="$(apparmor_parser -r "$BUILDKIT_APPARMOR_FILE" 2>&1)"; then
			log "loaded AppArmor profile ${BUILDKIT_APPARMOR_PROFILE} for rootless BuildKit"
			return 0
		fi
		# A profile the parser rejects (AppArmor older than 4.0 has no
		# userns rule) would also fail apparmor.service at every boot.
		rm -f "$BUILDKIT_APPARMOR_FILE"
		failure="apparmor_parser could not load ${BUILDKIT_APPARMOR_FILE}: ${out}"
	fi
	if userns_restricted; then
		die "${failure}. BuildKit cannot start while kernel.apparmor_restrict_unprivileged_userns=1; fix this and re-run the installer (see \"AppArmor\" in install/README.md)"
	fi
	warn "${failure}; skipped the ${BUILDKIT_APPARMOR_PROFILE} AppArmor profile, which builds need only if kernel.apparmor_restrict_unprivileged_userns is set to 1"
}

# prepull_builder_images fetches the pinned BuildKit and registry images so
# the first build does not wait for them.
prepull_builder_images() {
	local image
	for image in "$BUILDKIT_IMAGE" "$REGISTRY_IMAGE"; do
		if docker image inspect "$image" >/dev/null 2>&1; then
			continue
		fi
		log "pulling ${image%@*}"
		docker pull --quiet "$image" >/dev/null || die "could not pull ${image}"
	done
}

# configure_firewall opens ingress when ufw is active, and otherwise says
# what to open. Nothing else needs to be reachable from outside.
configure_firewall() {
	if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
		log "ufw is active: allowing inbound 80/tcp, 443/tcp and 443/udp for ingress"
		ufw allow 80/tcp >/dev/null
		ufw allow 443/tcp >/dev/null
		ufw allow 443/udp >/dev/null
		if [ "$BUILDER" = 1 ]; then
			# BuildKit's container pushes through the agent's per-build
			# registry proxy on the build network's gateway.
			ufw allow in on "$BUILD_BRIDGE" to any port "$REGISTRY_PROXY_PORT" proto tcp >/dev/null
		fi
	else
		log "firewall: allow inbound 80/tcp and 443/tcp (443/udp for HTTP/3) for ingress; Roundhouse needs no other inbound port"
	fi
}

# NOTE: the unit below is a verbatim copy of install/roundhouse-agent.service,
# embedded because this script runs via curl | bash with no other files
# available. CI fails if the two differ.
install_service() {
	log "installing systemd unit"
	cat >"$UNIT_PATH" <<'UNIT'
[Unit]
Description=Roundhouse node agent
Documentation=https://github.com/BankkRoll/Roundhouse
Wants=network-online.target docker.service caddy.service
After=network-online.target docker.service caddy.service

[Service]
Type=simple
ExecStart=/usr/local/bin/roundhouse-agent run --config /etc/roundhouse/agent.yaml
Restart=always
RestartSec=5
TimeoutStopSec=20
LimitNOFILE=65536
UMask=0077

# Runs as root so it owns its files and can open /var/run/docker.sock
# (root:docker 0660) as the socket's owner. Docker API calls run in the
# daemon, and every file it touches is root-owned. Its only capabilities
# are CAP_NET_ADMIN and CAP_NET_RAW, for the iptables rules in DOCKER-USER
# that keep containers away from the cloud metadata endpoint. On builder
# nodes it also runs git and railpack, which inherit this sandbox; their
# checkouts live in the state directory and are removed after each build.
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW
StateDirectory=roundhouse
StateDirectoryMode=0700
# /run/roundhouse/secrets holds mount_as_file values on the tmpfs, bind-
# mounted into running containers, so it must outlive an agent restart.
RuntimeDirectory=roundhouse
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
# The agent records the control plane's key id in its config after the
# first verified welcome.
ReadWritePaths=-/etc/roundhouse
# iptables-legacy serialises on this lock; iptables-nft does not use it.
ReadWritePaths=-/run/xtables.lock
# Managed-mode TLS certificates live outside the 0700 state directory so
# Caddy (group caddy) can read them; install.sh creates it root:caddy 2750.
ReadWritePaths=-/var/lib/roundhouse-certs
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateMounts=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# /var/run/docker.sock stays reachable under ProtectSystem=strict because
# connecting to a socket is not a filesystem write. PrivateDevices,
# PrivateNetwork and ProtectProc are left off; they would hide the host the
# agent reports on and manages.

[Install]
WantedBy=multi-user.target
UNIT
	systemctl daemon-reload
	systemctl enable roundhouse-agent.service >/dev/null
	# NOTE: restart rather than start so a re-run picks up a new binary.
	systemctl restart roundhouse-agent.service
}

main() {
	parse_args "$@"
	require_root
	check_os
	check_arch
	check_builder_role
	check_resources
	check_docker_flavour

	WORK_DIR="$(mktemp -d)"
	trap on_exit EXIT

	wait_for_cloud_init
	install_prereqs
	acquire_token
	install_agent
	join_control_plane
	install_packages
	configure_firewall
	install_service

	log "Roundhouse agent is running. Follow logs with: journalctl -u roundhouse-agent -f"
}

# NOTE: ROUNDHOUSE_INSTALL_SOURCE_ONLY=1 makes sourcing this script define
# its functions without running anything, so CI and install/test can run a
# single step (such as install_buildkit_apparmor) exactly as an install does.
if [ "${ROUNDHOUSE_INSTALL_SOURCE_ONLY:-0}" != 1 ]; then
	main "$@"
fi
