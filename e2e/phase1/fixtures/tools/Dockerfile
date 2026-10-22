# Helper image for the Phase 1 end-to-end test: an HTTPS git server
# (git-http-backend behind a tiny Node CGI bridge) and an HTTP prober that
# reaches Caddy from inside the engine's host network.
# Build context: e2e/phase1/fixtures.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
RUN apk add --no-cache git git-daemon openssl
COPY tools/git-server.mjs tools/probe.mjs tools/init-repos.sh /opt/e2e/
COPY repos /opt/e2e/repos
# A Windows checkout may carry CRLF line endings; the scripts and the
# committed sources must not.
RUN find /opt/e2e -type f -exec sed -i 's/\r$//' {} + && chmod 0755 /opt/e2e/init-repos.sh
