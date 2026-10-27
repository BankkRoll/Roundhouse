#!/usr/bin/env bash
#
# Exercises install/install.sh end to end inside a bare distro container, as
# CI does for each supported OS:
#
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist:/dist:ro" ubuntu:24.04 \
#     bash /src/install/test/container-test.sh
#
# /dist must hold a linux agent binary built with -X main.version=0.0.0-ci.
#
# A stub control plane on 127.0.0.1 serves a release signed with a throwaway
# key and answers the join; systemctl and docker are stubbed because
# containers run neither systemd nor a Docker daemon. Caddy and Railpack are
# installed for real, from their pinned sources. The test asserts that
# preflight passes, that /etc/os-release does not clobber the script's own
# name and version settings, that the pinned version is the one downloaded
# and verified, that --builder joins as a builder, installs Railpack and
# pre-pulls the builder images, that Caddy is installed and starts with an
# empty, agent-owned config, and that a re-run is idempotent.

set -euo pipefail

VERSION=0.0.0-ci
NODE=ci-node-$$
PORT=8787
ARCH="$(dpkg --print-architecture)"

log() { printf '\n### %s\n' "$*"; }
fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

# pinned prints the value of NAME=... (quotes stripped) from install.sh.
pinned() {
	sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" /src/install/install.sh
}

log "harness dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 openssl curl ca-certificates >/dev/null

log "stubs for systemctl and docker"
cat >/usr/local/bin/systemctl <<'EOF'
#!/bin/sh
echo "$*" >>/tmp/systemctl.log
EOF
# The docker stub records its calls and reports an image present once pulled.
cat >/usr/local/bin/docker <<'EOF'
#!/bin/sh
echo "$*" >>/tmp/docker.log
case "$1" in
--version) echo "Docker version 29.0.0, build ci" ;;
image) [ "$2" = inspect ] && grep -qxF "$3" /tmp/docker-images 2>/dev/null ;;
pull)
	for a in "$@"; do ref="$a"; done
	echo "$ref" >>/tmp/docker-images
	;;
esac
EOF
chmod +x /usr/local/bin/systemctl /usr/local/bin/docker
mkdir -p /etc/systemd/system

log "signed test release"
rel="/tmp/rel/agent-v${VERSION}"
mkdir -p "$rel"
cp "/dist/roundhouse-agent-linux-${ARCH}" "$rel/"
(
	cd "$rel"
	{
		printf '# version: agent-v%s\n' "$VERSION"
		sha256sum "roundhouse-agent-linux-${ARCH}"
	} >SHA256SUMS
	openssl genpkey -algorithm ed25519 -out /tmp/release.key 2>/dev/null
	openssl pkey -in /tmp/release.key -pubout -out /tmp/release.pub
	openssl pkeyutl -sign -rawin -inkey /tmp/release.key -in SHA256SUMS -out SHA256SUMS.sig
)

log "installer as the control plane would serve it"
awk -v keyfile=/tmp/release.pub '
	/^-----BEGIN PUBLIC KEY-----$/ { while ((getline line < keyfile) > 0) print line; skip = 1; next }
	skip && /^-----END PUBLIC KEY-----$/ { skip = 0; next }
	!skip { print }
' /src/install/install.sh |
	sed -e "s#__CONTROL_PLANE_URL__#http://127.0.0.1:${PORT}#g" \
		-e "s#__AGENT_VERSION__#${VERSION}#g" >/tmp/install.sh
grep -q 'BEGIN PUBLIC KEY' /tmp/install.sh || fail "release key missing from patched installer"

log "stub control plane"
cat >/tmp/cp.py <<EOF
import http.server, json, os

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory="/tmp", **kw)

    def do_POST(self):
        if self.path != "/v1/nodes/join":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers["Content-Length"]))
        with open("/tmp/joins.jsonl", "ab") as f:
            f.write(body + b"\n")
        out = json.dumps({
            "node_id": "node_ci",
            "credential": "nc_ci",
            "control_public_key": "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
            "connect_url": "ws://127.0.0.1:${PORT}/v1/nodes/node_ci/connect",
        }).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

http.server.ThreadingHTTPServer(("127.0.0.1", ${PORT}), H).serve_forever()
EOF
python3 /tmp/cp.py 2>/tmp/cp.log &
cp_pid=$!
caddy_pid=""
cleanup() {
	kill "$cp_pid" 2>/dev/null || true
	if [ -n "$caddy_pid" ]; then kill "$caddy_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
for _ in $(seq 50); do
	python3 -c "import socket; socket.create_connection(('127.0.0.1', ${PORT}), 1)" 2>/dev/null && break
	sleep 0.1
done

export ROUNDHOUSE_DOWNLOAD_BASE="http://127.0.0.1:${PORT}/rel"

log "first install, as a builder"
bash /tmp/install.sh --token njt_ci --name "$NODE" --builder

log "assertions: agent"
[ "$(wc -l </tmp/joins.jsonl)" -eq 1 ] || fail "expected exactly one join"
python3 - "$NODE" "$VERSION" <<'EOF'
import json, sys
node, version = sys.argv[1], sys.argv[2]
req = json.loads(open("/tmp/joins.jsonl").readline())
assert req["name"] == node, f"name {req['name']!r} != {node!r}"
assert req["agent_version"] == version, f"agent_version {req['agent_version']!r} != {version!r}"
assert req["token"] == "njt_ci", "token not passed through"
assert req["capabilities"]["builder"] is True, f"not joined as a builder: {req['capabilities']!r}"
print("join request OK:", req["name"], req["agent_version"], req["os"], req["capabilities"])
EOF
[ "$(/usr/local/bin/roundhouse-agent version)" = "$VERSION" ] || fail "installed agent is not ${VERSION}"
grep -q '^node_id: node_ci$' /etc/roundhouse/agent.yaml || fail "config not written"
grep -q '^builder: true$' /etc/roundhouse/agent.yaml || fail "builder role not recorded in the config"
cmp /etc/systemd/system/roundhouse-agent.service /src/install/roundhouse-agent.service ||
	fail "installed unit differs from install/roundhouse-agent.service"
grep -q 'restart roundhouse-agent.service' /tmp/systemctl.log || fail "service not restarted"
if find /tmp -maxdepth 2 -name token -type f | grep -q .; then
	fail "token temp file left behind"
fi
command -v git >/dev/null || fail "git not installed"
[ -s /etc/ssl/certs/ca-certificates.crt ] || fail "ca-certificates not installed"

log "assertions: Caddy"
command -v caddy >/dev/null || fail "caddy not installed"
caddy version
grep -q "signed-by=/etc/apt/keyrings/caddy-stable.asc" /etc/apt/sources.list.d/caddy-stable.list ||
	fail "Caddy repository not configured with the pinned key"
dropin=/etc/systemd/system/caddy.service.d/roundhouse.conf
grep -qx 'ExecStart=/usr/bin/caddy run --environ --resume' "$dropin" || fail "Caddy not started with --resume"
grep -qx 'Environment=CADDY_ADMIN=localhost:2019' "$dropin" || fail "Caddy admin API not pinned to localhost:2019"
grep -qx 'ExecReload=' "$dropin" || fail "Caddy reload not disabled"
grep -q 'enable caddy.service' /tmp/systemctl.log || fail "caddy not enabled"
[ "$(grep -c 'restart caddy.service' /tmp/systemctl.log)" -eq 1 ] || fail "caddy not restarted exactly once"
certs_dir="$(stat -c '%U:%G %a' /var/lib/roundhouse-certs 2>/dev/null)"
[ "$certs_dir" = "root:caddy 2750" ] || fail "certificates directory is ${certs_dir:-missing}, want root:caddy 2750"

# Run Caddy as its unit would, and check it comes up with an empty config on
# the admin API rather than the packaged Caddyfile.
read -ra exec_start <<<"$(sed -n 's/^ExecStart=\(.\{1,\}\)$/\1/p' "$dropin")"
(cd / && CADDY_ADMIN=localhost:2019 XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data \
	"${exec_start[@]}" >/tmp/caddy.log 2>&1) &
caddy_pid=$!
config=""
for _ in $(seq 50); do
	config="$(curl -fsS http://localhost:2019/config/ 2>/dev/null)" && break
	sleep 0.2
done
[ "$config" = "null" ] || fail "Caddy started with config ${config:-<no answer>}: $(cat /tmp/caddy.log)"
if curl -fsS -m 2 http://127.0.0.1:80/ >/dev/null 2>&1; then
	fail "Caddy serves the packaged Caddyfile"
fi
kill "$caddy_pid"
wait "$caddy_pid" 2>/dev/null || true
caddy_pid=""

log "assertions: builder"
[ "$(/usr/local/bin/railpack --version | awk '{ print $NF }')" = "$(pinned RAILPACK_VERSION)" ] ||
	fail "railpack $(pinned RAILPACK_VERSION) not installed"
for image in "$(pinned BUILDKIT_IMAGE)" "$(pinned REGISTRY_IMAGE)"; do
	[ "$(grep -cxF "pull --quiet ${image}" /tmp/docker.log)" -eq 1 ] || fail "${image} not pulled exactly once"
done

log "re-run without a token is idempotent"
railpack_mtime="$(stat -c %Y /usr/local/bin/railpack)"
chown root:root /var/lib/roundhouse-certs
chmod 0700 /var/lib/roundhouse-certs
sleep 1
bash /tmp/install.sh
[ "$(wc -l </tmp/joins.jsonl)" -eq 1 ] || fail "re-run joined again"
[ "$(stat -c '%U:%G %a' /var/lib/roundhouse-certs)" = "root:caddy 2750" ] ||
	fail "re-run did not restore the certificates directory's owner and mode"
[ "$(stat -c %Y /usr/local/bin/railpack)" = "$railpack_mtime" ] || fail "re-run reinstalled railpack"
[ "$(grep -c '^pull ' /tmp/docker.log)" -eq 2 ] || fail "re-run pulled images again"
[ "$(grep -c 'restart caddy.service' /tmp/systemctl.log)" -eq 1 ] || fail "re-run restarted caddy"
grep -q '^builder: true$' /etc/roundhouse/agent.yaml || fail "re-run lost the builder role"
[ "$(grep -c 'restart roundhouse-agent.service' /tmp/systemctl.log)" -eq 2 ] || fail "re-run did not restart the agent"

log "a joined non-builder cannot become a builder without re-joining"
cp /etc/roundhouse/agent.yaml /tmp/agent.yaml.bak
sed -i '/^builder:/d' /etc/roundhouse/agent.yaml
if bash /tmp/install.sh --builder 2>/tmp/builder.log; then
	fail "installer accepted --builder on a joined non-builder"
fi
grep -q "re-run with --rejoin --builder" /tmp/builder.log || fail "unexpected failure: $(cat /tmp/builder.log)"
cp /tmp/agent.yaml.bak /etc/roundhouse/agent.yaml

log "a pinned version must match the signed version line"
# A correctly signed release served under another version's path, as a
# malicious mirror might, must be refused.
cp -r "$rel" /tmp/rel/agent-v0.0.1-other
if bash /tmp/install.sh --version 0.0.1-other 2>/tmp/mismatch.log; then
	fail "installer accepted checksums signed for another version"
fi
grep -q "signed checksums are for agent-v${VERSION}" /tmp/mismatch.log ||
	fail "unexpected failure: $(cat /tmp/mismatch.log)"

log "BuildKit AppArmor profile"
profile_file=/etc/apparmor.d/roundhouse-buildkit
# securityfs is never mounted in a container, so the real install above
# must have skipped the profile whatever the host kernel does.
[ ! -e "$profile_file" ] || fail "profile installed without AppArmor's policy interface"

# The step itself runs against fixture kernel interfaces and a stub parser,
# by sourcing the installer and calling the function an install calls.
aa=/tmp/aa
mkdir -p "$aa/bin" "$aa/fs/features/namespaces"
touch "$aa/fs/features/namespaces/userns_create"
cat >"$aa/bin/apparmor_parser" <<'EOF'
#!/bin/sh
echo "$*" >>/tmp/aa/parser.log
if [ -e /tmp/aa/parser-fails ]; then
	echo "AppArmor parser error: Could not open 'abi/4.0'" >&2
	exit 1
fi
EOF
chmod +x "$aa/bin/apparmor_parser"
# aa_step <enabled Y|N> <restrict 0|1|-> [fs dir]; "-" means no sysctl.
aa_step() {
	printf '%s\n' "$1" >"$aa/enabled"
	rm -f "$aa/restrict"
	if [ "$2" != - ]; then printf '%s\n' "$2" >"$aa/restrict"; fi
	PATH="$aa/bin:$PATH" ROUNDHOUSE_INSTALL_SOURCE_ONLY=1 AA_FS="${3:-$aa/fs}" bash -c '
		. /tmp/install.sh
		APPARMOR_ENABLED=/tmp/aa/enabled
		APPARMOR_FS="$AA_FS"
		USERNS_RESTRICT_SYSCTL=/tmp/aa/restrict
		install_buildkit_apparmor
	' >"$aa/out" 2>&1
}
parser_calls() { if [ -f "$aa/parser.log" ]; then wc -l <"$aa/parser.log"; else echo 0; fi; }

aa_step N 1 || fail "AppArmor disabled: step failed: $(cat "$aa/out")"
[ ! -e "$profile_file" ] || fail "AppArmor disabled: profile installed"
[ "$(parser_calls)" -eq 0 ] || fail "AppArmor disabled: parser called"

aa_step Y 1 || fail "restricted host: step failed: $(cat "$aa/out")"
cmp "$profile_file" /src/install/roundhouse-buildkit.apparmor || fail "installed profile differs from install/roundhouse-buildkit.apparmor"
[ "$(stat -c %a "$profile_file")" = 644 ] || fail "profile mode $(stat -c %a "$profile_file")"
grep -qxF -e "-r ${profile_file}" "$aa/parser.log" || fail "profile not loaded: $(cat "$aa/parser.log")"

mtime="$(stat -c %Y "$profile_file")"
sleep 1
aa_step Y 1 || fail "re-run failed: $(cat "$aa/out")"
[ "$(stat -c %Y "$profile_file")" = "$mtime" ] || fail "re-run rewrote an unchanged profile"
[ "$(parser_calls)" -eq 2 ] || fail "re-run did not reload the profile"

# Kernels that mediate user namespaces without Ubuntu's sysctl.
rm -f "$profile_file"
aa_step Y - || fail "no sysctl: step failed: $(cat "$aa/out")"
[ -f "$profile_file" ] || fail "no sysctl: profile not installed"

touch "$aa/parser-fails"
aa_step Y 0 || fail "parser failure without the restriction must only warn: $(cat "$aa/out")"
grep -q 'skipped the roundhouse-buildkit AppArmor profile' "$aa/out" || fail "no warning: $(cat "$aa/out")"
[ ! -e "$profile_file" ] || fail "unloadable profile left in /etc/apparmor.d"

if aa_step Y 1; then fail "parser failure with the restriction on was not fatal"; fi
grep -q 'kernel.apparmor_restrict_unprivileged_userns=1' "$aa/out" || fail "unexpected failure: $(cat "$aa/out")"
rm -f "$aa/parser-fails"

aa_step Y 1 /nonexistent || fail "no securityfs: step failed: $(cat "$aa/out")"
grep -q 'is not mounted' "$aa/out" || fail "no securityfs: no warning: $(cat "$aa/out")"
[ ! -e "$profile_file" ] || fail "no securityfs: profile installed"

# Ubuntu 24.04 ships AppArmor 4, whose parser can check the profile itself;
# older releases cannot parse the userns rule, which is why a parser failure
# is tolerated while the restriction is off.
if grep -qx "ID=ubuntu" /etc/os-release && grep -qx "VERSION_ID=\"24.04\"" /etc/os-release; then
	apt-get install -y -qq --no-install-recommends apparmor >/dev/null
	# -Q compiles without loading, which needs no kernel support.
	apparmor_parser -Q -K /src/install/roundhouse-buildkit.apparmor >/tmp/aa-parse.log 2>&1 ||
		fail "apparmor_parser rejects install/roundhouse-buildkit.apparmor: $(cat /tmp/aa-parse.log)"
	echo "apparmor_parser $(apparmor_parser --version | awk 'NR == 1 { print $NF }') accepts the profile"
fi

log "uninstall removes the AppArmor profile"
aa_step Y 1 || fail "reinstalling the profile failed: $(cat "$aa/out")"
PATH="$aa/bin:$PATH" bash /src/install/uninstall.sh >/tmp/uninstall.log 2>&1 || fail "uninstall failed: $(cat /tmp/uninstall.log)"
[ ! -e "$profile_file" ] || fail "uninstall left ${profile_file}"
grep -qxF -e "-R ${profile_file}" "$aa/parser.log" || fail "uninstall did not unload the profile"
[ ! -e /usr/local/bin/roundhouse-agent ] || fail "uninstall left the agent binary"

echo "PASS"
