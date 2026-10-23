# A Roundhouse node for the Phase 1 end-to-end test: the agent binary plus
# what install.sh puts on a builder (git, CA certificates, the pinned
# Railpack CLI). Caddy runs in its own container on the same host network,
# as it runs as its own systemd service on a real node, so restarting the
# agent never restarts ingress.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

ARG RAILPACK_VERSION=0.43.0
ARG RAILPACK_SHA256_AMD64=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb
ARG RAILPACK_SHA256_ARM64=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eu; \
	case "$(dpkg --print-architecture)" in \
	amd64) triple=x86_64-unknown-linux-musl; sum="$RAILPACK_SHA256_AMD64" ;; \
	arm64) triple=arm64-unknown-linux-musl; sum="$RAILPACK_SHA256_ARM64" ;; \
	esac; \
	asset="railpack-v${RAILPACK_VERSION}-${triple}.tar.gz"; \
	curl -fsSL --proto "=https" -o "/tmp/${asset}" \
		"https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${asset}"; \
	echo "${sum}  /tmp/${asset}" | sha256sum -c --quiet -; \
	tar -xzf "/tmp/${asset}" -C /usr/local/bin railpack; \
	rm "/tmp/${asset}"; \
	railpack --version

COPY roundhouse-agent entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/roundhouse-agent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
