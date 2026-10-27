#!/bin/sh
# Starts the node's Docker engine and Caddy, then runs the agent command
# given as arguments (`idle` keeps the node up without an agent, for join).
set -eu

dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
i=0
until docker info >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -gt 120 ]; then
		echo "dockerd did not start" >&2
		tail -n 50 /var/log/dockerd.log >&2
		exit 1
	fi
	sleep 0.5
done

CADDY_ADMIN=localhost:2019 caddy run --resume >/var/log/caddy.log 2>&1 &

if [ "${1:-}" = "idle" ]; then
	exec sleep infinity
fi
exec /usr/local/bin/roundhouse-agent "$@"
