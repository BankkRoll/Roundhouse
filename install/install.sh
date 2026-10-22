#!/usr/bin/env bash
#
# OpenRail node installer.
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
#   --binary <p>      DEV ONLY: install a local agent binary, skipping download
#                     and signature verification.
#
# Environment:
#   OPENRAIL_DOWNLOAD_BASE  Release download base
#                           (default: https://github.com/BankkRoll/Open-Rail/releases/download).
#                           Version v is fetched from <base>/agent-v<v>/; "latest"
#                           is fetched from the sibling <base>/../latest/download/,
#                           GitHub's redirect to the newest release, so mirrors must
#                           mimic that layout.
#   OPENRAIL_SKIP_OS_CHECK  Set to 1 to install on an unsupported distribution.
#
# Order of work: the join token is single-use and short-lived, so the agent
# is downloaded and joined first, and only then are Docker and the other slow
# dependencies installed.
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
# infra/release-signing.md). The block below is a PLACEHOLDER whose private
# half was discarded; replace it before the first release. While it is
# present, downloads are refused and only --binary works.
RELEASE_PUBLIC_KEYS_PEM="$(
	cat <<'PEM'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkHLBdd+mLYOoixvDbr8za3PLXSGyGu4wFPf5jmAiK88=
-----END PUBLIC KEY-----
PEM
)"
PLACEHOLDER_KEY_DER_B64="MCowBQYDK2VwAyEAkHLBdd+mLYOoixvDbr8za3PLXSGyGu4wFPf5jmAiK88="

DOWNLOAD_BASE="${OPENRAIL_DOWNLOAD_BASE:-https://github.com/BankkRoll/Open-Rail/releases/download}"
BIN_PATH=/usr/local/bin/openrail-agent
CONFIG_PATH=/etc/openrail/agent.yaml
UNIT_PATH=/etc/systemd/system/openrail-agent.service
APT_GET=(apt-get -o DPkg::Lock::Timeout=300)

MIN_CPUS=1
# NOTE: a "1 GiB" VM reports ~950 MiB in MemTotal after kernel reservations,
# so the floor sits below the advertised requirement.
MIN_MEM_KIB=$((900 * 1024))
MIN_DISK_KIB=$((10 * 1024 * 1024))

# NOTE: these globals must not share names with /etc/os-release variables
# (NAME, VERSION, ID, ...); os-release is only ever read in a subshell.
TOKEN=""
TOKEN_FILE=""
NODE_NAME=""
AGENT_VERSION=""
LOCAL_BINARY=""
REJOIN=0
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
                  [--version <v>] [--rejoin] [--binary <path>]

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
		if [ "${OPENRAIL_SKIP_OS_CHECK:-0}" = 1 ]; then
			warn "unsupported OS ${OS_PRETTY}; continuing because OPENRAIL_SKIP_OS_CHECK=1"
		else
			die "unsupported OS ${OS_PRETTY}: OpenRail supports Ubuntu 22.04, Ubuntu 24.04 and Debian 12"
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
	*) die "unsupported architecture $(uname -m): OpenRail supports x86_64 and aarch64" ;;
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
	disk_kib="$(df -Pk /var/lib | awk 'NR == 2 { print $4 }')"
	[ "$disk_kib" -ge "$MIN_DISK_KIB" ] ||
		die "need at least 10 GiB free disk on /var/lib, found $((disk_kib / 1024 / 1024)) GiB"
	log "resources OK: ${cpus} vCPU, $((mem_kib / 1024)) MiB RAM, $((disk_kib / 1024 / 1024)) GiB free"
}

# check_docker_flavour refuses Docker installs the agent cannot drive, before
# the join token is spent.
check_docker_flavour() {
	local docker_bin
	docker_bin="$(command -v docker || true)"
	[ -n "$docker_bin" ] || return 0
	case "$(readlink -f "$docker_bin")" in
	/snap/*) die "Docker is installed as a snap, which OpenRail does not support; run 'snap remove docker' and re-run this script" ;;
	esac
	if dpkg -s podman-docker >/dev/null 2>&1 || docker --version 2>/dev/null | grep -qi podman; then
		die "'docker' is provided by Podman (podman-docker), which OpenRail does not support; remove podman-docker and re-run this script"
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
		printf 'OpenRail join token: ' >/dev/tty
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
	local dir="$1" asset="openrail-agent-linux-${ARCH}" base
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
	apt_install wireguard-tools

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

	# TODO(phase-1): install Caddy for ingress and TLS termination.
	# TODO(phase-2): install gVisor (runsc) and register it as a Docker runtime.
}

# NOTE: the unit below is a verbatim copy of install/openrail-agent.service,
# embedded because this script runs via curl | bash with no other files
# available. CI fails if the two differ.
install_service() {
	log "installing systemd unit"
	cat >"$UNIT_PATH" <<'UNIT'
[Unit]
Description=OpenRail node agent
Documentation=https://github.com/BankkRoll/Open-Rail
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/openrail-agent run --config /etc/openrail/agent.yaml
Restart=always
RestartSec=5
TimeoutStopSec=20
LimitNOFILE=65536
UMask=0077

# Runs as root so it owns its files and can open /var/run/docker.sock
# (root:docker 0660) as the socket's owner. It needs no capabilities: Docker
# API calls run in the daemon, and every file it touches is root-owned.
# Later phases that manage WireGuard will add CAP_NET_ADMIN here.
CapabilityBoundingSet=
StateDirectory=openrail
StateDirectoryMode=0700
# The agent records the control plane's key id in its config after the
# first verified welcome.
ReadWritePaths=-/etc/openrail
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
	systemctl enable openrail-agent.service >/dev/null
	# NOTE: restart rather than start so a re-run picks up a new binary.
	systemctl restart openrail-agent.service
}

main() {
	parse_args "$@"
	require_root
	check_os
	check_arch
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
	install_service

	log "OpenRail agent is running. Follow logs with: journalctl -u openrail-agent -f"
}

main "$@"
