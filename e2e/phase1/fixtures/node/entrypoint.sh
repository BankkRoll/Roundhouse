#!/bin/sh
# Trusts the test git server's CA the way an operator would trust a private
# forge: through the system store, which the builder's git uses.
set -eu
if [ -f /e2e-certs/ca.crt ]; then
	cp /e2e-certs/ca.crt /usr/local/share/ca-certificates/roundhouse-e2e.crt
	update-ca-certificates >/dev/null 2>&1
fi
exec roundhouse-agent "$@"
