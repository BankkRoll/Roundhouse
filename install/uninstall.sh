#!/usr/bin/env bash
#
# Removes the OpenRail agent from this host:
#
#   sudo bash uninstall.sh
#
# Stops and removes the systemd unit, the agent binary, its config and its
# state (including the node credential and identity key).
#
# Docker, Caddy, git, wireguard-tools and any containers (including a
# builder's sys_buildkitd and registry, and their volumes) are left untouched:
# they may be serving traffic or be used by other software. Remove them
# yourself if this host is being decommissioned. Railpack and the Caddy
# service override installed for OpenRail are removed. The node also stays
# registered with the control plane until you delete it from the dashboard.

set -euo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
	printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
	exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root"

if systemctl list-unit-files openrail-agent.service >/dev/null 2>&1; then
	log "stopping openrail-agent"
	systemctl disable --now openrail-agent.service >/dev/null 2>&1 || true
fi
rm -f /etc/systemd/system/openrail-agent.service
# Without the override Caddy falls back to the packaged Caddyfile on its next
# restart; the routes the agent configured keep serving until then.
rm -f /etc/systemd/system/caddy.service.d/openrail.conf
rmdir /etc/systemd/system/caddy.service.d 2>/dev/null || true
systemctl daemon-reload
systemctl reset-failed openrail-agent.service >/dev/null 2>&1 || true

log "removing binary, config and state"
rm -f /usr/local/bin/openrail-agent /usr/local/bin/railpack
rm -rf /etc/openrail /var/lib/openrail

log "OpenRail agent removed."
log "Docker, Caddy, wireguard-tools and existing containers were left in place."
log "Delete this node in the OpenRail dashboard to remove it from the control plane."
