# A meshed Roundhouse node for the multi-node end-to-end test: its own
# Docker engine (Docker in Docker), so each node has its own network
# namespace, bridges, nftables and wg0 exactly as a host would, plus Caddy
# and the agent, as install.sh sets up a node.
FROM docker:29-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977

RUN apk add --no-cache nftables caddy bind-tools curl

COPY roundhouse-agent entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
	&& chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/roundhouse-agent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
