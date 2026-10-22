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
# containers run neither systemd nor a Docker daemon. The test asserts that
# preflight passes, that /etc/os-release does not clobber the script's own
# name and version settings, that the pinned version is the one downloaded
# and verified, and that a re-run is idempotent.

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

log "harness dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 openssl >/dev/null

log "stubs for systemctl and docker"
cat >/usr/local/bin/systemctl <<'EOF'
#!/bin/sh
echo "$*" >>/tmp/systemctl.log
EOF
cat >/usr/local/bin/docker <<'EOF'
#!/bin/sh
echo "Docker version 27.0.0, build ci"
EOF
chmod +x /usr/local/bin/systemctl /usr/local/bin/docker
mkdir -p /etc/systemd/system

log "signed test release"
rel="/tmp/rel/agent-v${VERSION}"
mkdir -p "$rel"
cp "/dist/openrail-agent-linux-${ARCH}" "$rel/"
(
	cd "$rel"
	{
		printf '# version: agent-v%s\n' "$VERSION"
		sha256sum "openrail-agent-linux-${ARCH}"
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
trap 'kill "$cp_pid" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
	python3 -c "import socket; socket.create_connection(('127.0.0.1', ${PORT}), 1)" 2>/dev/null && break
	sleep 0.1
done

export OPENRAIL_DOWNLOAD_BASE="http://127.0.0.1:${PORT}/rel"

log "first install"
bash /tmp/install.sh --token njt_ci --name "$NODE"

log "assertions"
[ "$(wc -l </tmp/joins.jsonl)" -eq 1 ] || fail "expected exactly one join"
python3 - "$NODE" "$VERSION" <<'EOF'
import json, sys
node, version = sys.argv[1], sys.argv[2]
req = json.loads(open("/tmp/joins.jsonl").readline())
assert req["name"] == node, f"name {req['name']!r} != {node!r}"
assert req["agent_version"] == version, f"agent_version {req['agent_version']!r} != {version!r}"
assert req["token"] == "njt_ci", "token not passed through"
print("join request OK:", req["name"], req["agent_version"], req["os"])
EOF
[ "$(/usr/local/bin/openrail-agent version)" = "$VERSION" ] || fail "installed agent is not ${VERSION}"
grep -q '^node_id: node_ci$' /etc/openrail/agent.yaml || fail "config not written"
cmp /etc/systemd/system/openrail-agent.service /src/install/openrail-agent.service ||
	fail "installed unit differs from install/openrail-agent.service"
grep -q 'restart openrail-agent.service' /tmp/systemctl.log || fail "service not restarted"
if find /tmp -maxdepth 2 -name token -type f | grep -q .; then
	fail "token temp file left behind"
fi

log "re-run without a token is idempotent"
bash /tmp/install.sh
[ "$(wc -l </tmp/joins.jsonl)" -eq 1 ] || fail "re-run joined again"

log "a pinned version must match the signed version line"
# A correctly signed release served under another version's path, as a
# malicious mirror might, must be refused.
cp -r "$rel" /tmp/rel/agent-v0.0.1-other
if bash /tmp/install.sh --version 0.0.1-other 2>/tmp/mismatch.log; then
	fail "installer accepted checksums signed for another version"
fi
grep -q "signed checksums are for agent-v${VERSION}" /tmp/mismatch.log ||
	fail "unexpected failure: $(cat /tmp/mismatch.log)"

echo "PASS"
