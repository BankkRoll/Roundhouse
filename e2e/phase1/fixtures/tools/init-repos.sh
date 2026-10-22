#!/bin/sh
# Creates the test's TLS material and bare repositories, then execs the git
# server. Commit dates are fixed so every run produces the same SHAs.
set -eu

certs=/certs
root=/srv/git

if [ ! -f "$certs/ca.crt" ]; then
	openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=openrail-e2e CA" \
		-keyout "$certs/ca.key" -out "$certs/ca.crt" 2>/dev/null
	openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" \
		-keyout "$certs/server.key" -out "$certs/server.csr" 2>/dev/null
	printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\n' >"$certs/san.ext"
	openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" \
		-CAcreateserial -days 7 -extfile "$certs/san.ext" -out "$certs/server.crt" 2>/dev/null
	chmod 0644 "$certs"/*.crt
fi

export GIT_AUTHOR_NAME=openrail-e2e GIT_AUTHOR_EMAIL=e2e@openrail.invalid
export GIT_COMMITTER_NAME=openrail-e2e GIT_COMMITTER_EMAIL=e2e@openrail.invalid
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"

# publish <name> <source dir> [<sed expression for a second commit>]
publish() {
	work="$(mktemp -d)"
	cp -R "/opt/e2e/repos/$2/." "$work/"
	git -C "$work" init -q -b main
	git -C "$work" add -A
	git -C "$work" commit -q -m "$1: first commit"
	if [ "${3:-}" != "" ]; then
		sed -i "$3" "$work/index.js"
		git -C "$work" commit -q -am "$1: second commit"
	fi
	rm -rf "${root:?}/$1.git"
	git clone -q --bare "$work" "$root/$1.git"
	git -C "$root/$1.git" config http.receivepack false
	git -C "$root/$1.git" config uploadpack.allowAnySHA1InWant true
	rm -rf "$work"
}

mkdir -p "$root"
publish app app 's/const VERSION = "v1";/const VERSION = "v2";/'
publish broken broken
publish slow slow

exec node /opt/e2e/git-server.mjs
