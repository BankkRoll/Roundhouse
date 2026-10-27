# 0005: Multi-node networking

## Status

Accepted; implemented 2026-10-27 (see "Implementation notes").
- Date: 2026-10-22
- Phase: 2
- Protocol: version 4 (see "Rollout and compat")
- Depends on: 0002, 0003 ("Environment networks", "Registry", "Ingress swaps
  without reloads"). 0004, 0009 and 0011 build on it.

Names follow the Roundhouse rename (0013, "Naming").

## Context

Phase 1 runs a project on one node in practice:
- Each environment has its own Docker bridge on the node, and Docker
  isolates bridges from each other. A bridge exists on one host only, so a
  replica on node A cannot reach a replica of the same environment on
  node B.
- Private domains are Docker network aliases, so they resolve only on the
  node that runs the target.
- Builds land in the builder's registry on `127.0.0.1:5000`. The scheduler
  sends git-built workloads only to nodes with `reachesRegistry`, which
  today means the builder itself.
- Caddy on a node routes only to replicas on that same node.
- Nodes dial out and may sit behind NAT (ADR 0002). There is no node-to-node
  channel at all.

Phase 2 must let a project span nodes without weakening the Phase 1
guarantee: no environment can reach another one, by name or by IP.

The `nodes` table already has `wg_ip` and `wg_pubkey` columns, and
`install.sh` already installs `wireguard-tools`.

Facts that constrain the design (sources at the end):
- **wgctrl-go** configures existing WireGuard devices: the Linux kernel
  module through generic netlink, and userspace devices through the UAPI
  socket. Creating the interface is out of its scope. `wgtypes` generates
  keys.
- **wireguard-go** can be embedded (`tun.CreateTUN`, `device.NewDevice`,
  `IpcSet`). The kernel module (mainline since 5.6) is faster and is
  preferred.
- **Keys.** WireGuard rotates session keys by itself (`REKEY_AFTER_TIME`
  120 s). Static keys never rotate; a static public key is the peer's
  identity, so replacing one means reconfiguring every peer. Preshared keys
  add post-quantum resistance.
- **NAT.** WireGuard does no NAT traversal. Endpoints roam on authenticated
  packets, and `PersistentKeepalive` 25 s keeps NAT mappings open. Two peers
  that are both behind NAT need hole punching or a relay.
- **Docker 28+** drops packets that arrive addressed to a container IP in
  raw prerouting. Only `trusted_host_interfaces`, `allow-direct-routing`
  or the `nat-unprotected`/`routed` gateway modes lift that drop, and even
  then only for published ports. Unpublished ports are dropped in the
  forward chain.
  - **Docker 29** adds `--bridge-accept-fwmark`, which overrides Docker's
    forward drops for marked packets on both the iptables and the nftables
    backend.
  - In nftables an accept is not final, so another table cannot override
    Docker's drop. A drop in our own table is final.
  - DNAT done by the host (priority dstnat, −100) runs after the raw drop
    (−300). A packet addressed to a host-owned address and DNATed by us is
    therefore not hit by the raw drop.
  - The nftables backend is still experimental in 29.9.2, and Docker 29
    removed the `DOCKER-ISOLATION-*` chains.
- **Docker DNS.** On a user-defined network, `HostConfig.Dns` replaces only
  the upstream servers of the embedded resolver at 127.0.0.11. The
  container's namespace queries them, so the server must be reachable from
  the container, for example on a host dummy interface.

## Decision

### Address plan

- **Mesh supernet** is `10.200.0.0/16`. It is an instance setting
  (`mesh_supernet`), fixed once the first node enters the mesh. It must
  not overlap Docker's default address pools (`172.17.0.0/16` and up,
  `192.168.0.0/16`).
- Each node gets an index `N` in 1–254 (`nodes.mesh_index`, unique) and owns
  `10.200.N.0/24`:

| Address              | Use                                                                               |
| -------------------- | --------------------------------------------------------------------------------- |
| `10.200.N.1`         | `wg0` address (`/16` on the interface, so the supernet routes via it)             |
| `10.200.N.2`         | Internal DNS, on dummy interface `rh-dns0` (`/32`)                                |
| `10.200.N.3`–`.9`    | Reserved (registry mesh listener uses `.1:5000`)                                  |
| `10.200.N.10`–`.254` | **Mesh IPs** of service replicas on the node (245 > `MAX_WORKLOADS_PER_NODE` 128) |

**Environment networks stay node-local Docker bridges**, as in the Phase 1
hardening, with Docker-assigned subnets. They are not carved from the /24:
a node can host any number of environments, and the per-environment L2
isolation Docker provides on one host is unchanged.

Every service replica also gets a **mesh IP** from its node's /24,
allocated by the control plane per placement (`placements.mesh_ip`, lowest
free, freed when the placement ends). The agent maps it 1:1 to the
container's bridge IP with nftables:
- DNAT on traffic arriving for the mesh IP;
- SNAT to the mesh IP on traffic the container sends over `wg0`.

Mesh IPs are how one replica reaches another across nodes. They are how
the environment "network" spans nodes.

### Mesh topology and key management

**Keys are generated on the agent.**
- With the mesh enabled (agent config `mesh.mode: auto | kernel | userspace
  | off`, default `auto`), the agent creates `<data-dir>/wireguard.key`
  (0600) with `wgtypes.GeneratePrivateKey`.
- It creates `wg0` through netlink (`ip link add wg0 type wireguard`, using
  `vishvananda/netlink`). If the kernel lacks the module, it falls back to
  embedded wireguard-go on `/dev/net/tun`.
- It configures `wg0` only through wgctrl.
- The private key never leaves the node.

**The control plane distributes peers** in `desired_state.mesh`, a signed
frame like any other. A node's peer list is every other node with a
`mesh_index`. The full mesh is O(n²) tunnels, which is fine up to the 254
nodes the address plan allows.

**Reachability.**
- The agent reports `nat: "public" | "nat"`. It is `public` when the
  control plane's observed address for the connection (`CF-Connecting-IP`
  at connect, forwarded to the node DO) is assigned to one of the node's
  interfaces, or when the operator sets `mesh.endpoint` (`host:port`,
  required when only a port forward makes the node reachable).
- Otherwise it is `nat`.
- The endpoint is `mesh.endpoint` or `<observed IP>:<listen_port>`.

**Pair paths.** The control plane chooses a path for each pair `{A, B}`:

| A           | B   | Path                                                                                                                                                                                                                                             |
| ----------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| public      | any | **direct**. The NAT side gets A's endpoint and `keepalive_s: 25`; the public side gets `endpoint: null` and learns B's address from B's first authenticated packet (roaming).                                                                    |
| nat         | nat | **relayed** through relay R: a public node, preferring label `roundhouse.io/mesh-relay=true`, then the lowest node ID. A's peer entry for R gets `allowed_ips` R/24 **and** B/24, and the same for B. R forwards `wg0 → wg0` for that pair only. |
| none public | —   | Mesh unavailable. Nodes report `mesh_ready: false`, and the scheduler keeps each environment on one node (see "Scheduler").                                                                                                                      |

A direct pair with no handshake for 120 s after both sides applied the
config falls back to relayed, and is tried direct again every 30 min. This
catches a firewall that blocks UDP 51820 although the node looked public.
Handshake times come from `mesh_status`.

A relay sees the relayed pair's traffic in plaintext between its two
tunnels. Relays are cluster nodes, which are trusted as much as any node,
and the dashboard shows which pairs are relayed.

**Preshared keys.** One 32-byte random PSK per pair, stored sealed in
`mesh_psks`, delivered in `desired_state` (which makes the frame
credential-carrying: TTL 60 s), and rotated whenever either node's key
rotates.

**Key rotation.** Rotation runs every 90 days
(`MESH_KEY_MAX_AGE_MS`), or on `POST .../nodes/{id}/mesh/rotate-key`:
1. The control plane sets `desired_state.mesh.rotate_key: true` for node X.
2. X generates a new key, keeps using the old one, and sends
   `mesh_key { public_key, epoch }`.
3. The control plane stores `nodes.wg_pubkey_next` and pushes every peer a
   peer list carrying X's new public key and new PSKs, at generation G.
4. Once every online peer reports `observed_generation >= G`, or 60 s have
   passed, the control plane sends X `mesh.activate_epoch: epoch`. X swaps
   its private key, and the control plane moves `wg_pubkey_next` to
   `wg_pubkey`.

Between steps 3 and 4, traffic between X and its peers fails to handshake,
typically for under 2 s. Rotation is per node and staggered, never two
nodes at once. Peers offline at step 3 get the new key at their next
`hello`.

### Protocol (version 4)

Agent → control:

```ts
// hello, additive (v4 agents only)
mesh?: {
  public_key: string;              // base64 raw 32 bytes
  listen_port: number;             // default 51820
  mode: "kernel" | "userspace" | "unavailable";
  nat: "public" | "nat";
  endpoint_override: string | null;  // "host:port" from agent config
  docker_firewall: "iptables" | "nftables";
  accept_fwmark: boolean;          // daemon runs with --bridge-accept-fwmark (or DOCKER-USER rule installed)
};

// new frame, every 30 s and on change; rate limit 4/s
{ type: "mesh_status";
  epoch: number;
  peers: { node_id: string; last_handshake_ms: number | null; endpoint: string | null;
           rx_bytes: number; tx_bytes: number }[];   // ≤ 253
  ready: boolean;                  // wg0 up, nftables applied, DNS listening
  error?: string }

// new frame, on rotation
{ type: "mesh_key"; public_key: string; epoch: number }
```

Control → agent: `desired_state` gains `mesh: MeshConfig | null`. `null`
means mesh off, and the agent tears `wg0` and its nftables table down.

```ts
interface MeshConfig {
  supernet: string; // "10.200.0.0/16"
  node_index: number; // 1..254
  address: string; // "10.200.N.1"
  dns_address: string; // "10.200.N.2"
  listen_port: number;
  mtu: number; // 1420
  accept_fwmark: number; // mark Docker accepts, e.g. 0x2000000
  rotate_key: boolean;
  activate_epoch: number | null;
  peers: {
    node_id: string;
    public_key: string;
    preshared_key: string; // credential
    endpoint: string | null;
    allowed_ips: string[];
    keepalive_s: 0 | 25;
  }[]; // ≤ 253
  forward_pairs: [string, string][]; // CIDR pairs this node relays (wg0→wg0)
  node_addresses: string[]; // every node's .1, the "ingress source" set
  addresses: {
    // mesh IPs this node must know, ≤ MAX_MESH_ADDRESSES (4096)
    ip: string;
    env_tag: number;
    node_id: string;
    routed_ports: number[];
  }[];
}
```

`addresses` lists every mesh IP of every environment that has a replica on
this node, local and remote. `env_tag` is `environments.net_tag`, a small
integer unique per install, assigned at environment creation, so nftables
can key on it.

`WorkloadSpec` gains two fields:
- `mesh_ip?: string`. It is **excluded** from the spec hash
  (`SPEC_HASH_EXCLUDED_FIELDS`), because a new mesh IP changes NAT rules,
  not the container.
- `private_dns?: boolean`. It is **included** in the hash. When true, the
  agent sets `HostConfig.Dns = [mesh.dns_address]`.

`RegistryConfigSchema` changes as described under "Registry over the
mesh".

`carriesCredentials(desired_state)` is now also true when `mesh.peers` is
non-empty (PSKs), so every desired state of a meshed node has a 60 s TTL.
It is recomputed from D1 on every send, so this costs nothing.

### Isolation with nftables

The agent owns one table, `inet roundhouse`, and replaces it atomically
(`nft -f` with `flush table` in the same transaction) whenever the inputs
change. It never edits Docker's tables. Structure:

```
table inet roundhouse {
  map mesh_dnat   { type ipv4_addr : ipv4_addr; }        # local mesh IP → bridge IP
  map mesh_snat   { type ipv4_addr : ipv4_addr; }        # local bridge IP → mesh IP
  map bridge_env  { type ipv4_addr : verdict; }          # local bridge IP → jump env_<tag>_out
  map mesh_env_in { type ipv4_addr : verdict; }          # local mesh IP  → jump env_<tag>_in
  set nodes       { type ipv4_addr; }                    # node .1 addresses
  set routed      { type ipv4_addr . inet_service; }     # mesh IP . port with an ingress route
  set env_<tag>   { type ipv4_addr; }                    # every mesh IP of env <tag>, cluster-wide

  chain pre   { type nat hook prerouting priority dstnat - 1;
                ip daddr @mesh_dnat dnat ip to ip daddr map @mesh_dnat }
  chain post  { type nat hook postrouting priority srcnat - 1;
                oifname "wg0" ip saddr @mesh_snat snat ip to ip saddr map @mesh_snat }
  chain fwd   { type filter hook forward priority filter - 1;
                # container → mesh (egress, on the sending node)
                iifname != "wg0" ip daddr 10.200.0.0/16 ip saddr vmap @bridge_env
                # mesh → container (ingress, on the receiving node; daddr already DNATed)
                iifname "wg0" ct original ip daddr vmap @mesh_env_in
                # relay
                iifname "wg0" oifname "wg0" <forward_pairs rules> meta mark set mark or <accept_fwmark> accept
                iifname "wg0" drop
                tcp flags syn tcp option maxseg size set rt mtu }
  chain env_<tag>_out { ip daddr @env_<tag> meta mark set mark or <accept_fwmark> accept; drop }
  chain env_<tag>_in  { ip saddr @env_<tag> meta mark set mark or <accept_fwmark> accept;
                        ip saddr @nodes ct original ip daddr . tcp dport @routed meta mark set mark or <accept_fwmark> accept;
                        drop }
  chain in    { type filter hook input priority filter - 1;
                ip daddr 10.200.N.2 udp dport 53 iifname != "wg0" accept
                ip daddr 10.200.N.2 tcp dport 53 iifname != "wg0" accept
                ip daddr 10.200.N.2 drop
                iifname "wg0" ip daddr 10.200.N.1 tcp dport 5000 ip saddr @nodes accept   # builder only
                iifname "wg0" ip daddr 10.200.N.1 drop }
}
```

Properties:
- **Same environment, different node.** The sending node checks the
  destination is in the source's environment (`env_<tag>_out`). The
  receiving node checks the source is in the destination's environment
  (`env_<tag>_in`), and WireGuard's cryptokey routing guarantees a packet
  from peer B carries a source inside B's /24. A compromised node can
  therefore only reach environments that already run on it.
- **Different environment.** The packet matches no accept and is dropped
  in our chain, which is final.
- **Accepts are marked, not just accepted.** The mark is what lets the
  packet through Docker's forward drop for unpublished ports
  (`--bridge-accept-fwmark`). Only packets that passed our policy carry
  it.
- **Ingress.** Caddy on node A reaching a replica on node B arrives from
  A's `.1`, and is accepted only for `(mesh IP, port)` pairs that have an
  ingress route.
- **Same node.** Traffic between environments on one node never touches
  this table. Docker's own per-bridge rules still drop it, exactly as in
  Phase 1.

**Docker prerequisites.** The agent checks them at start and reports
`accept_fwmark`.
- **iptables backend** (the default): the agent inserts
  `-I DOCKER-USER -m mark --mark <m>/<m> -j ACCEPT` once and re-checks it
  every reconcile, because Docker recreates `DOCKER-USER` on restart.
- **nftables backend**: the daemon must run with
  `--bridge-accept-fwmark=<m>/<m>` (Docker ≥ 29.0). `install.sh` writes
  `"bridge-accept-fwmark": "0x2000000/0x2000000"` into `daemon.json` on
  fresh installs.
- **Either backend**: `net.ipv4.ip_forward=1`, set through
  `/etc/sysctl.d/60-roundhouse.conf` by `install.sh`. Docker's nftables
  backend no longer enables forwarding itself.

A node without `accept_fwmark` reports `mesh_ready: false` with the reason.
The dashboard shows the exact fix.

### Internal DNS

The agent serves `<service>.<environment>.<project>.internal` (slugs) on
`10.200.N.2:53`, UDP and TCP, through the DNS server it already runs for
Caddy upstreams (`internal/ingress/dns.go`).
- **Who may ask.** It answers only queries whose source is a local
  container bridge IP. Docker's embedded resolver forwards from the
  container's namespace, so the source is the container. It looks up the
  asker's environment and answers only names in that same environment.
  Anything else gets `NXDOMAIN`, so names don't leak across environments,
  although nftables is what actually enforces isolation.
- **What it answers.** `A` records for the target service's replicas,
  healthy ones first. If none are healthy, it returns all of them, so a
  client sees connection-refused instead of a resolution failure. TTL is
  5 s.
  - A target replica on the **same node** is answered with its bridge IP,
    so no hairpin NAT is needed.
  - A target replica on **another node** is answered with its mesh IP.
- **Phase 1 names.** The old `<service>.<environment>.internal` form is
  answered the same way, inferring the project from the asker. The Docker
  network alias for it stays, so Docker's resolver keeps answering it
  locally first.
- **Built-ins.** `ROUNDHOUSE_PRIVATE_DOMAIN` becomes the four-label form.
  `privateDomain()` in `lib/desired-state.ts` takes the project slug.
- **Other names.** Everything else is refused (`REFUSED`), so Docker's
  resolver moves on to the host's upstream servers.

`private_dns: true` is set on every service workload of a meshed node.
Turning it on changes the spec hash, so each replica is replaced once by
the normal rollout. Volume services restart once (`stop_first`, 0004).

### Cross-node ingress

The upstream DNS on `127.0.0.1:2021` now answers a route's name with:
- the **bridge IPs** of healthy local replicas;
- the **mesh IPs** of healthy replicas on other nodes.

Local replicas are preferred: remote ones are returned only when no local
replica is healthy, or when the node has none. Caddy's config is
unchanged, and swaps still never reload it.

Every node with `capabilities.ingress` (new, default true) receives every
route of every environment in `desired_state.workloads[].routes`. For a
service with no replica on that node, the routes arrive as a **route-only
workload**: `kind: "route"`, no image, no container, routes plus the
target service's `(mesh IP, port)` list in `upstreams`. A v3 agent never
receives one (see "Rollout and compat").

```ts
// added to WORKLOAD_KINDS in v4: "route"
// route workloads: image, env, resources, healthcheck ignored; spec_hash covers routes + upstreams
upstreams?: { ip: string; port: number }[];
```

DNS for `*.apps_domain` may then point at any or all ingress nodes. 0009
covers custom domains.

### Registry over the mesh

So that any node can pull builds, every meshed node runs `sys_registry` on
`127.0.0.1:5000`. Image references stay `127.0.0.1:5000/<project>/<service>@sha256:…`
everywhere, so spec hashes and Phase 1 rows are unchanged. Docker treats
`127.0.0.1` registries as insecure-allowed.

```ts
RegistryConfigSchema = {
  listen: "127.0.0.1:5000";
  mode: "primary" | "replica" | "proxy";       // v4; absent = "primary"
  storage: RegistryStorage;                   // primary: filesystem|s3; replica: s3 (read-only keys); proxy: filesystem cache
  mesh_listen?: "10.200.N.1:5000";            // primary only
  upstream?: { url: string; username: string; password: string };   // proxy only; credential
  pull_users?: { username: string; bcrypt: string }[];             // primary only
}
```

- **S3/R2 storage**, recommended for more than one node: builders run
  `primary` with read-write keys. Every other node runs `replica` against
  the same bucket, with `storage.maintenance.readonly.enabled` and a
  read-only R2 token, which is a second instance-setting key pair. This
  path needs no mesh, so `reachesRegistry` is true for every node with the
  keys.
- **Filesystem storage**, the single-builder default: the builder publishes
  its registry on `10.200.B.1:5000` as well, with htpasswd auth, one
  generated user per node (`pull_users`), reachable only from `@nodes`.
  Every other node runs `proxy` mode (pull-through cache) with `upstream =
  http://10.200.B.1:5000` and its own credentials. The hop is inside
  WireGuard, so it is encrypted without TLS. Filesystem storage supports
  exactly one builder; adding a second builder requires S3 storage, and
  the API refuses otherwise with `409 registry_requires_s3`.
- The scheduler's `reachesRegistry` becomes: S3 storage, or the node _is_
  the builder, or the node has a recent handshake (`< 180 s`) with the
  builder.

### Scheduler across nodes

`packages/shared/src/scheduler.ts` stays pure and deterministic. It gains
the following.

```ts
interface SchedulerNode {
  // existing fields …
  protocolVersion: number;
  diskMb: number; // disk available to volumes
  allocatedDiskMb: number; // sum of volume quotas on the node (0004)
  meshReady: boolean;
  zone: string | null; // labels["topology.roundhouse.io/zone"]
}
interface ScheduleRequest {
  // existing fields …
  minProtocolVersion: number; // 4 for volumes, mesh-dependent placement, route workloads
  pinnedNodeId: string | null; // 0004: a service with a volume
  excludeNodeIds: string[]; // drain, reschedule
  diskMb: number; // 0004: new volume quota, 0 otherwise
  requiresMesh: boolean; // the environment already has replicas on another node
  environmentNodeIds: string[]; // nodes already hosting this environment
}
```

**Filters**, in this order. `SCHEDULE_FAILURE_REASONS` follows the same
order, so the "deepest filter" explanation still works: `offline`,
`excluded`, `pinned_elsewhere`, `agent_outdated`, `no_docker`,
`selector_mismatch`, `mesh_unready`, `registry_unreachable`,
`insufficient_disk`, `insufficient_memory`, `insufficient_cpu`.

`mesh_unready` rejects a node without `meshReady` when the environment
already lives on another node. Without a working mesh, an environment
therefore never spans nodes.

**Scoring** is unchanged except for a zone term: spread penalty 1 per
same-service replica on the node, plus 0.5 per same-service replica in the
same zone, then bin-packing, then node ID.

### Node lifecycle

`NODE_STATUSES` keeps `draining` and `maintenance`, both operator-set:
- `draining` means no new placements, and the drain workflow is moving
  workloads off.
- `maintenance` means drained and safe to reboot. Heartbeats don't change
  it.

Routes:

| Method and path                                            | RBAC              | Audit                       |
| ---------------------------------------------------------- | ----------------- | --------------------------- |
| `POST /v1/workspaces/{ws}/nodes/{nodeId}/drain` `{force?}` | `nodes:manage`    | `node.drain_started`        |
| `POST /v1/workspaces/{ws}/nodes/{nodeId}/resume`           | `nodes:manage`    | `node.resumed`              |
| `POST /v1/workspaces/{ws}/nodes/{nodeId}/mesh/rotate-key`  | `nodes:manage`    | `node.mesh_key_rotated`     |
| `GET /v1/workspaces/{ws}/mesh`                             | `nodes:read`      | none                        |
| `PATCH /v1/instance/settings` `{mesh_supernet}`            | `instance:manage` | `instance.settings_updated` |

`GET /mesh` returns nodes, pair paths (`direct`/`relayed`/`down`), last
handshakes and readiness, for the dashboard's Servers → Network view.

**Drain** is a Workflow, `DRAIN_WORKFLOW`, with the instance ID
`drain-<node_id>-<ts>`:
1. Set the node to `draining`.
2. For each live placement on the node, **stateless** first, schedule the
   same deployment replica elsewhere (`excludeNodeIds: [node]`), insert a
   new placement with a new `wl_` ID and mesh IP, push desired state, and
   wait until it is `healthy`. Mark the old placement
   `ended_at = now, state = 'removed'` and push the drained node's state,
   whose agent then drains and removes the replica as usual. Moves run 4
   at a time, and a service with replicas on the node never loses more
   than one at a time.
3. Services with a **volume** (0004) are not moved. Without `force`, the
   workflow stops at `blocked`, lists them, and the dashboard offers
   "migrate volume" (0004) for each. With `force`, they are stopped and
   their services marked `degraded`, with reason `node_maintenance`.
4. Set the node to `maintenance` and emit `node.drained`.

`resume` sets the node to `online`. Nothing moves back on its own; new
deployments may use the node again.

**Offline handling.** A node is `offline` 30 s after its last heartbeat
(`OFFLINE_AFTER_MS`), as today. The node DO alarm then waits
`RESCHEDULE_AFTER_MS = 120_000` more, to ride out agent restarts and
network blips. After that:
- **Stateless** replicas of live deployments are rescheduled like a drain
  move, without waiting for the old one. The old placement is
  `state = 'lost'`. If the node comes back, its next `desired_state` no
  longer lists those workloads, and the agent removes them. Both copies
  may serve for the moments in between, which is acceptable for stateless
  services.
- **Stateful** replicas are not moved. Their services are marked
  `degraded` with reason `node_offline`, and an alert fires (0008). The
  dashboard offers "restore latest backup onto another node" (0004,
  restore with `target_node_id`).

`placements` changes to allow moves:

```sql
ALTER TABLE placements ADD COLUMN mesh_ip TEXT;
ALTER TABLE placements ADD COLUMN ended_at INTEGER;
DROP INDEX placements_deployment_replica_uq;
CREATE UNIQUE INDEX placements_deployment_replica_live_uq
  ON placements(deployment_id, replica) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX placements_node_mesh_ip_uq
  ON placements(node_id, mesh_ip) WHERE ended_at IS NULL AND mesh_ip IS NOT NULL;
```

`WORKLOAD_STATES` is unchanged; `lost` is a placement-only state.

`services` gains `health` (`ok | degraded`) and `health_reason`. This is
service-level health, separate from deployment status.

Other schema changes:

```sql
ALTER TABLE nodes ADD COLUMN mesh_index INTEGER;      -- unique where not null
ALTER TABLE nodes ADD COLUMN wg_pubkey_next TEXT;
ALTER TABLE nodes ADD COLUMN wg_key_rotated_at INTEGER;
ALTER TABLE nodes ADD COLUMN mesh_nat TEXT;           -- public | nat
ALTER TABLE nodes ADD COLUMN mesh_endpoint TEXT;
ALTER TABLE nodes ADD COLUMN mesh_ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE environments ADD COLUMN net_tag INTEGER;  -- unique, assigned at create
CREATE TABLE mesh_psks (
  pair_key TEXT PRIMARY KEY,              -- "<lower node id>|<higher node id>"
  psk_sealed TEXT NOT NULL,               -- AAD "mesh-psk:<pair_key>", sealed under the KEK
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE mesh_paths (
  pair_key TEXT PRIMARY KEY, path TEXT NOT NULL,   -- direct | relayed | down
  relay_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  last_handshake_at INTEGER, last_direct_attempt_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

New audit actions: `node.drain_started`, `node.drained`, `node.resumed`,
`node.mesh_key_rotated`, `node.mesh_joined`, `service.degraded`,
`service.recovered`.

### Agent responsibilities

- `internal/mesh` (new) handles:
  - the key file and `wg0` lifecycle, kernel or userspace;
  - wgctrl configuration with `ReplacePeers: true` from each desired
    state;
  - the `rh-dns0` dummy interface;
  - `mesh_status` every 30 s;
  - the rotation protocol.
- `internal/netpol` (new) renders and atomically applies the `inet
  roundhouse` table and the `DOCKER-USER` mark rule, and verifies them
  every reconcile, because Docker restarts recreate its own chains.
- `internal/ingress/dns.go` gains the private zone and the remote answers
  for route names.
- `internal/runtime` sets `HostConfig.Dns` from `private_dns`, keeps the
  bridge-IP ↔ mesh-IP maps, and handles route-only workloads (routes with
  no container).
- Mesh setup is never fatal. If it fails, the agent keeps running local
  workloads and reports `ready: false` with an error.

### Dashboard

- **Servers → Network** draws nodes as a grid with lines between them,
  coloured by pair path: green for direct, amber for relayed, red for
  down. Hovering a line shows the last handshake, endpoint and bytes. A
  readiness checklist per node (kernel or userspace, fwmark, UDP 51820
  reachable, DNS) links to docs.
- The **node detail** page gets Drain, Resume and Rotate mesh key buttons.
  A drain progress list shows each move, and pinned services come with
  "migrate volume" actions.
- **Service health**: a `degraded` badge with its reason on the canvas
  node and in the service header.

## Security

- **Control.** Peer lists, PSKs and mesh IP sets travel only in signed
  `desired_state` frames with a 60 s TTL. A node accepts mesh
  configuration from nothing else.
- **Keys.** Private keys never leave the node. PSKs are sealed at rest
  under the KEK. Mesh key rotation is routine (90 days) and
  operator-triggerable after a suspected compromise. Removing a node drops
  it from every peer list at the next generation.
- **Isolation.** Isolation is enforced twice: by the sending node and by
  the receiving node, and the receiving check relies on WireGuard's
  source-address binding. A compromised node reaches only environments
  that already run on it, plus ingress routes it would serve anyway.
- **Exposure.**
  - Internal DNS listens only on a host-only address and is accepted only
    from local bridges.
  - The registry's mesh listener is limited to node addresses and requires
    per-node credentials.
  - Nothing new listens on public interfaces except UDP 51820.
- **Relays** see relayed traffic decrypted. Relay nodes are visible in the
  dashboard and can be pinned to dedicated nodes with the label.

## Testing strategy

- **Unit (TS).**
  - Address allocation: mesh index, mesh IP and `net_tag` reuse rules.
  - The pair-path chooser as a table test over every reachability
    combination.
  - The scheduler's new filters and zone spreading, with determinism
    property tests.
  - `carriesCredentials` with PSKs.
- **Unit (Go).**
  - nftables ruleset rendering as golden files.
  - The DNS answer policy: same environment, cross-environment, local and
    remote replicas.
  - The rotation state machine.
- **Shared fixtures.** `fixtures/signed-desired-state-mesh.json` and
  `fixtures/mesh-status.json`, verified by both TS and Go.
- **Agent integration** (`agent/test/integration.sh -run Mesh`). The test
  needs Linux with the WireGuard kernel module, or userspace mode. It
  starts two agent containers with `--cap-add NET_ADMIN --device
  /dev/net/tun`, each with its own Docker-in-Docker engine
  (`docker:29-dind`, pinned by digest), so they behave as two hosts, then
  checks:
  - both projects' environments reach each other across "nodes" only
    within an environment, by name and by IP (`TestMeshIsolation`);
  - a relayed pair works when both nodes are marked `nat` and a third,
    public node relays;
  - a key rotation loses at most 3 s of a request loop between nodes.
- **Real-stack e2e** (`e2e/phase2`, run by `node e2e/phase2/run.mjs`). The
  stack is the Phase 1 stack plus a second node, both as dind containers
  on one user-defined network, so the engine and its iptables behave as on
  a real host. It runs on Docker Desktop and on GitHub Actions
  `ubuntu-latest`.
  1. Two nodes join and the mesh comes up: the direct path shows in
     `GET /mesh`, and both report `mesh_ready`.
  2. A Next.js app on node A and Postgres on node B (`node_selector`)
     work: the app reaches `db.production.<project>.internal:5432`.
     Ingress on node B serves the app through A's replica.
  3. A staging environment spread across both nodes cannot reach
     production by IP or name.
  4. `POST drain` on A moves the app to B with no failed requests in a
     loop through B's ingress.
  5. `docker stop` on node B's agent and engine: after 150 s, stateless
     replicas are rescheduled to A, and Postgres's service is `degraded`.
     Restarting B removes its stale replicas.

## Rollout and compat

- **Protocol 4.** `PROTOCOL_VERSION = 4` and `MIN_PROTOCOL_VERSION = 3`
  (N−1; see 0013). New gate: `MESH_PROTOCOL_VERSION = 4`.
- **v3 agents** are never sent `mesh`, route-only workloads, `mesh_ip`,
  `private_dns` or registry `mode`. The scheduler's `agent_outdated` filter
  keeps v4-only placements off them, and they keep working as Phase 1
  single-node hosts.
- **Turning the mesh on** is opt-in per install: Settings → Network →
  Enable mesh, `instance:manage`. A one-node install has nothing to do.
  Nodes join the mesh one by one, as each reports `mesh.public_key` at
  `hello`.
- **Upgrading** needs `install.sh --upgrade`, which opens UDP 51820 in ufw,
  writes the sysctl, and adds the fwmark key to `daemon.json` (a Docker
  restart, announced). Hetzner firewalls created by `ensureFirewall` are
  never rewritten (packages/providers/README.md), so the dashboard tells the
  operator to add `51820/udp`, and new provisions include it:
  `defaultFirewallRules` gains `51820/udp`.

## Consequences

- One environment can span nodes, so placement can spread and drain can
  move work.
- The NAT layer adds conntrack state and a second address per replica.
  Debugging needs `GET /mesh` and the agent's `nft list table inet
  roundhouse` dump in the diagnostics bundle.
- Installs where every node is behind NAT get no mesh. They still run,
  with each environment confined to one node.

## Implementation notes

Built (2026-10-27): the address plan, keys and pair paths
(`apps/api/src/lib/mesh.ts`), `desired_state.mesh` with route-only
workloads (`lib/desired-state.ts`), `hello.mesh`, `mesh_status` and
`mesh_key` (`durable/node-connection.ts`), `GET /mesh` and key rotation,
the agent's WireGuard device, nftables table and private DNS
(`agent/internal/{mesh,netpol,ingress}`); then cron runs on the mesh, the
registry over the mesh, drain and offline rescheduling, and the scheduler
additions. Where the build differs from the decision above:

**Protocol and contracts**
- **Version.** The mesh shipped at protocol 5 (`MESH_PROTOCOL_VERSION = 5`),
  not 4: protocol 4 went to sealed environments first (ADR 0014).
- **Preshared keys** travel as one box per frame (`mesh.psks_sealed`,
  sealed to the node's X25519 key with AAD `meshPsksAad(node, generation)`)
  instead of a `preshared_key` per peer, so the frame's plaintext never
  holds one.
- **`MeshAddress`** gained `private_domain` and `healthy`, which the
  agent's private DNS needs to answer names and order replicas.

**Reachability**
- **NAT inference** is the agent's: `nat: "public"` when `mesh.endpoint` is
  set, or when an up interface (not Docker's, `wg0`, `rh-dns0` or
  loopback) holds a global IPv4 that is not RFC 1918, CGNAT or link-local;
  else `nat`. The control plane then builds the endpoint from the override,
  or from `CF-Connecting-IP` and the listen port for a public node. A node
  is public for path selection exactly when it has an endpoint.
- **Both public** pairs get each other's endpoint and no keepalive; the
  roaming-only rule applies to the public side of a public/NAT pair.

**Isolation and DNS (agent)**
- The `fwd` chain starts with `ct state established,related` (marked
  and accepted), so replies of cross-node connections pass before
  `iifname "wg0" drop`; `wg0` traffic with a source outside the supernet
  is dropped in `fwd` and `in`.
- **Names other than `*.internal`** are forwarded to the host's resolvers
  for local askers, not `REFUSED`: `HostConfig.Dns` replaces Docker's
  upstreams, so a refusal would leave containers without public DNS.
- **`ROUNDHOUSE_PRIVATE_DOMAIN` keeps the three-label form**
  `<service>.<environment>.internal`. The private DNS answers both forms
  (the three-label one inferring the project from the asker), so nothing
  that already reads the variable breaks; the four-label form is what the
  mesh addresses carry.

**Cross-node ingress**
- A service with a local replica also gets a route-only workload listing
  its replicas on other nodes; the agent serves them only while no local
  replica is healthy, so an ingress node fails over instead of answering
  "no route".

**Data model**
- **No `ended_at`.** A mesh IP is cleared when its deployment stops being
  live, and `placements_node_mesh_ip_uq` is unique on `(node_id, mesh_ip)`
  where `mesh_ip` is set. A move (drain, offline rescheduling) inserts a
  second placement for the replica (`replaces_workload_id`) and **deletes**
  the old row once the new one is healthy; `placements_deployment_replica_uq`
  became a plain index. No reader needs an `ended_at IS NULL` filter; the
  ones that collapse replicas (deployment health) count a replica healthy
  when either of its rows is.
- **Placement-only states** are `lost` (rescheduled away from an offline
  node) and `parked` (stopped by a forced drain). Desired state, serving,
  the mesh and the scheduler leave both out; agent reports never overwrite
  them.
- Rotation state lives on the node row (`wg_key_epoch`, `wg_key_next_epoch`,
  `mesh_rotate_*`, `mesh_activate_epoch`) and the reported mesh state in
  `mesh_mode`, `mesh_endpoint_override`, `mesh_listen_port`,
  `mesh_docker_firewall`, `mesh_accept_fwmark`, `mesh_error` and
  `mesh_status_at`. `mesh_paths` keeps each side's last report (`sides`)
  and `configured_at`. Everything is in migration 0021.

**Cron runs**
- A run placed on a meshed node gets `cron_runs.mesh_ip` from the node's
  /24, live while it is `starting` or `running` (a partial unique index
  frees it the moment it ends). Runs take addresses from the top of the
  range down and replicas from the bottom up; a collision found after the
  write gives the run's address back. The `job_run` workload carries
  `mesh_ip` and `private_dns`; every meshed node lists the run's address
  under its cron service's private name, and is refreshed when the run
  starts and ends. Runs follow the environment span rule like replicas.

**Registry over the mesh**
- **Pull credentials** live on the node row: user `node-<ULID lowercase>`,
  32 random bytes sealed under the KEK (`registry_pull`, field = node ID),
  and the bcrypt hash computed once with `bcryptjs` when the password is
  made. Key rotation re-seals them.
- **One builder per workspace** with filesystem storage: the oldest
  builder-capable node is the designated builder; only it gets builds and
  runs `primary` (with `mesh_listen` and `pull_users` once other meshed
  nodes exist). Other builder-capable nodes pull like any node. The 409
  `registry_requires_s3` is answered where a builder is chosen by the
  operator: provisioning a builder server while the workspace already has
  one, and going back to filesystem storage while a workspace has two. A
  hand-joined agent reports its capability itself, so it is never refused,
  only not designated.
- **S3 storage** is the `registry_storage` instance setting
  (`GET/PUT/DELETE /v1/instance/registry-storage`, instance admins, fresh
  session) with both secrets sealed and write-only, re-wrapped by key
  rotation; both key pairs are probed before saving. Builders run `primary`
  on the bucket with the read-write keys; other nodes at protocol 5 run
  `replica` with the read-only keys.
- **`reachesRegistry`** follows the rule above, reading handshakes from
  `mesh_paths`: a relayed pair counts when both legs (node to relay, relay
  to builder) handshook within 180 s.

**Node lifecycle**
- **Drain progress** is a `node_drains` row (moves, blocked services,
  status `running | blocked | failed | completed | cancelled`), read with
  `GET /v1/workspaces/{ws}/nodes/{id}/drain`. A move that finds no node or
  never becomes healthy ends the drain `failed` with the node still
  `draining` (the old replica keeps serving); resume cancels a running
  drain.
- **Forced drains park** volume services' replicas instead of removing
  them, and mark the services `degraded` (`node_maintenance`); resume
  restarts them on the node that holds their data and clears the health.
- **Only settled deployments move** (`active`, `crashed`); a deployment
  still rolling out decides its own fate.
- **Offline rescheduling** runs once per outage (`nodes.rescheduled_at`,
  cleared at the next hello), from the node Durable Object's alarm at
  `OFFLINE_AFTER_MS + RESCHEDULE_AFTER_MS` of silence. A returning node's
  `node_offline` services recover at its hello; its `lost` rows go when
  their replacement is healthy or the agent reports them `removed`. The
  alert ADR 0008 would fire is the `service.degraded` audit entry for now.
- **Zones.** The zone term counts the node's own replicas too, as the text
  says ("+0.5 per same-service replica in the same zone").

**Not built here**
- The dashboard parts (Network view, drain buttons and progress, degraded
  badges) and the CLI belong to the web and CLI work.
- The relayed-pair and key-rotation integration tests, and the
  `e2e/phase2` real-stack run.

## Open questions

- Should a Roundhouse-run relay (UDP over WebSocket through the node DO) be
  added for all-NAT installs? Workers have no inbound UDP, so it would
  carry mesh traffic through the control plane and its WebSocket limits.
  Not now.
- IPv6 inside the mesh: the address plan is IPv4 only. IPv6 endpoints for
  the outer tunnel are supported.
- Does the registry's `proxy` mode accept an `http://` `remoteurl` on every
  version we pin? The control plane sends `http://<builder .1>:5000`; the
  agent's two-node integration test is where it is confirmed.
- Once the nftables firewall backend leaves experimental, re-verify the
  mark override on each Docker minor release. CI runs the isolation test
  against both backends.

## Sources

- wgctrl-go (configures kernel and userspace devices; creating interfaces is out of scope), https://pkg.go.dev/golang.zx2c4.com/wireguard/wgctrl (v0.0.0-20241231184526, retrieved 2026-10-22); `wgtypes`, https://pkg.go.dev/golang.zx2c4.com/wireguard/wgtypes
- wireguard-go embedding (`tun.CreateTUN`, `device.NewDevice`), https://pkg.go.dev/golang.zx2c4.com/wireguard (2026-10-06 pseudo-version, retrieved 2026-10-22); kernel module preferred, https://git.zx2c4.com/wireguard-go/about/
- Kernel timers (`REKEY_AFTER_TIME` 120 s, `REJECT_AFTER_TIME` 180 s), https://github.com/torvalds/linux/blob/master/drivers/net/wireguard/messages.h (retrieved 2026-10-22)
- Roaming, cryptokey routing, keepalive 25 s, https://www.wireguard.com/ and https://www.wireguard.com/quickstart/ (retrieved 2026-10-22); PSK, https://www.wireguard.com/protocol/
- NAT traversal and relays, https://tailscale.com/blog/how-nat-traversal-works (retrieved 2026-10-22)
- wg-quick MTU (default route MTU − 80 = 1420), https://github.com/WireGuard/wireguard-tools/blob/master/src/wg-quick/linux.bash (retrieved 2026-10-22)
- Docker 28.0.0 direct-routing block and gateway modes; 28.2.0 `trusted_host_interfaces` and `allow-direct-routing`, https://docs.docker.com/engine/release-notes/28/ and https://docs.docker.com/engine/network/port-publishing/ (retrieved 2026-10-22)
- Docker 29.0.0 nftables backend (experimental), `--bridge-accept-fwmark`, no `DOCKER-USER`, accept not final, https://docs.docker.com/engine/network/firewall-nftables/ and https://docs.docker.com/engine/release-notes/29/ (29.9.2 is latest, 2026-10-20; retrieved 2026-10-22)
- iptables backend chains, `DOCKER-USER` after DNAT, removal of `DOCKER-ISOLATION-*` in 29.0.0, https://docs.docker.com/engine/network/firewall-iptables/ (retrieved 2026-10-22)
- moby rule dumps, https://github.com/moby/moby/tree/docker-v29.9.2/integration/network/bridge/nftablesdoc (retrieved 2026-10-22)
- Embedded DNS with `--dns` upstreams queried from the container namespace, https://docs.docker.com/engine/network/#dns-services (retrieved 2026-10-22)
