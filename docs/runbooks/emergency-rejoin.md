# Emergency re-join after a signing-key compromise

Use this when the control plane's Ed25519 signing key (the key every agent
pins to verify control frames) may be known to someone else: a leaked
database export together with `MASTER_KEY`, a compromised Cloudflare account,
a stolen backup of `instance_settings`, or anything else that could expose
the private half.

**A compromise is not a rollover** (ADR 0014 section 13). A normal rollover
announces the successor to agents in frames signed by the current key. Whoever
holds the current key can sign an announcement of their own "successor", and
an agent would pin it. So after a compromise no agent's key file can be
trusted: every node gets a new identity by re-joining with a new join token.

The procedure, in order:
1. [Declare the incident](#1-declare-the-incident)
2. [Rotate the master key, if it may be exposed too](#2-rotate-the-master-key-if-it-may-be-exposed-too)
3. [Replace the signing key](#3-replace-the-signing-key)
4. [Re-join every node](#4-re-join-every-node)
5. [Verify](#5-verify)
6. [Audit](#6-audit)

## Before you start

- You need an **instance admin** account with two-factor authentication on.
  Every change below needs a **fresh session**: one signed in, or confirmed
  with your password, within the last 10 minutes. The dashboard asks for the
  password when needed; the API answers `403 reauth_required` otherwise.
- **API tokens cannot do any of this.** The signing-key routes are
  session-only, and join tokens refuse API tokens. Using the CLI, unset
  `ROUNDHOUSE_TOKEN` and run `roundhouse login`.
- You need root (SSH or console) on every node. A node you cannot reach
  can only be removed, not re-joined.
- Join tokens are single-use and expire after 15 minutes: mint one per node,
  right before you use it.
- Work node by node in a quiet period. Between steps 3 and 4 the nodes keep
  running their containers, but the control plane cannot manage them.

## 1. Declare the incident

1. Record what is suspected and since when. Note the current key id: on the
   **Platform** page (`/w/<workspace>/platform`), **Signing keys** →
   **Current key**, or `current.kid` from `GET /v1/instance/signing-keys`.
2. If a rollover is already scheduled (**Next key** is set, or `next` is not
   `null`), its successor was announced in frames the suspect key signed and
   may be sealed under a suspect master key. Withdraw it: **Cancel the
   rollover**, or `DELETE /v1/instance/signing-keys/next` (audited as
   `key.rollover_cancelled`). This only works before its `not_before`; if it
   is already due, go on to step 3 and complete it with force, then start
   again with a new successor.
3. List the nodes to re-join, per workspace: **Servers**, or
   `roundhouse servers list --workspace <ws>`. Keep the node IDs; names may
   repeat once nodes re-join.

## 2. Rotate the master key, if it may be exposed too

The signing key's private half is an instance secret sealed under a key
derived from `MASTER_KEY`. If the master key may have leaked as well, a new
signing key sealed under it is no safer. Rotate it **first**, so the
successor in step 3 is sealed under the new key. The full procedure is in
[docs/configuration.md](../configuration.md#rotating-the-master-key). In
short:
1. Set `MASTER_KEYS_PREVIOUS` to the old key and `MASTER_KEY` to a new one
   (`npx wrangler secret put …`). Everyone is signed out; sign in again.
2. `POST /v1/instance/keys/rotate` (fresh session; audited as
   `instance.key_rotation_started`) re-seals every stored secret, the signing
   keys included.
3. Poll `GET /v1/instance/keys` until `previous_keys_removable` is `true`,
   then `npx wrangler secret delete MASTER_KEYS_PREVIOUS` and destroy every
   copy of the old key.

There is no CLI command for this; use the API or the dashboard.

If only the signing key is suspected (for example, a frame log or a memory
dump), skip this step.

## 3. Replace the signing key

There is no single "replace now" action. The emergency replacement is a
rollover with the shortest delay, completed with force, which deletes the old
private key.

1. Schedule a successor with the minimum delay of one hour: **Roll over to a
   new key** with **Switch after: 1 hour**, or

   ```http
   POST /v1/instance/signing-keys/rotate
   { "delay_hours": 1 }
   ```

   Audited as `key.rollover_scheduled`. A `409` means a rollover is already
   scheduled; see step 1.2.
2. Wait until `not_before` (the **Next key** row shows it; `next.due` turns
   `true`). Completing earlier is refused with `409`.
3. Complete with force: **Complete the rollover**, tick **Complete anyway**,
   or

   ```http
   POST /v1/instance/signing-keys/complete
   { "force": true }
   ```

   Without `force` the request is refused while any node does not pin the
   successor, which is expected here. Completion makes the successor the
   signing key, **deletes the old private key**, and keeps only the old key
   id in `retired`. It is audited as `key.rollover_completed` with
   `forced: true` and the IDs of the nodes left behind.

From now on the control plane signs only with the new key. Nodes that pinned
only the old key show **Re-join needed** (`rejoin_required`) and cannot
verify control frames. Nodes that pinned the successor show **Ready**, but
re-join them too: they may also have pinned a key an attacker announced.

Complete before minting join tokens: a node that joins while the old key is
still active is handed the old key to pin.

## 4. Re-join every node

For each node, one at a time:

1. **Mint a join token** in the node's workspace: **Servers → Add server**,
   or

   ```sh
   roundhouse servers add --workspace <ws>
   ```

   which calls `POST /v1/workspaces/{workspaceId}/nodes/join-tokens` (fresh
   session; audited as `node.join_token_created`) and prints the install
   command. If the CLI says a recent sign-in is needed, run
   `roundhouse login` again.
2. **Revoke the old node.** In the dashboard, open the server and choose
   **Remove server**; for a server Roundhouse provisioned, choose **Keep the
   server at …**. With the CLI:

   ```sh
   roundhouse servers remove <old-node-id> --keep-server --yes
   ```

   This calls `DELETE /v1/workspaces/{workspaceId}/nodes/{nodeId}?keep_server=true`:
   the node's credential stops working, its open connection is cut, and
   `node.removed` is audited. **Without `--keep-server` a provisioned cloud
   server is deleted along with everything on it.** A server joined by hand
   is never deleted.
3. **Re-join on the host**, as root, adding `--rejoin` to the printed command:

   ```sh
   curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token> --rejoin
   ```

   `--rejoin` runs `roundhouse-agent join --force`: the agent generates a new
   identity and encryption key, registers as a **new node with a new ID**,
   pins the control plane's current key, and ignores the key file of the
   previous registration; the previous registration's credential and key
   files are removed. The installer then restarts `roundhouse-agent`.
   - The name defaults to the hostname; pass `--name <n>` to keep another.
   - A builder stays a builder: the role is read from the existing
     `/etc/roundhouse/agent.yaml`.
   - Prefer `--token-file <path>` over `--token` in automation; the token is
     visible in the process list otherwise.
4. **Redeploy** the services that ran on the old node. Nothing moves
   workloads off a removed node by itself, and the scheduler places replicas
   only on live nodes.

A node you cannot reach: do step 2 only. Its agent can no longer connect.

## 5. Verify

`GET /v1/instance/signing-keys` (or the **Signing keys** section) should
show:
- `retired.kid` is the old key id, and `current.kid` the new one;
- `next` is `null`;
- every entry in `nodes` has `state: "ready"`, and no `pinned_kids` contains
  the retired kid. Removed nodes are no longer listed.

Then, per workspace, `roundhouse servers list` shows each host once, online,
under its new ID, and the redeployed services are healthy.

## 6. Audit

In the instance audit log (`GET /v1/instance/audit-logs`, filter with
`action=`), confirm the sequence and that nothing else happened in between:
- `key.rollover_cancelled` (if a rollover was pending),
- `instance.key_rotation_started` and `instance.key_rotation_completed` (if
  the master key was rotated),
- `key.rollover_scheduled` and `key.rollover_completed` (`forced: true`),
- per node: `node.join_token_created`, `node.removed`, `node.joined`.

Every `node.joined` should match a token you minted; one you cannot account
for means someone else holds a join token. `GET /v1/instance/audit-logs/verify`
checks the audit chain has not been altered.

## What this does not cover

- **How the key leaked.** Find and close that first, or the new key goes the
  same way.
- **Other secrets.** Rotate API tokens (`roundhouse tokens revoke`), GitHub
  App and cloud-provider credentials, and the variables of affected projects
  if the database or master key was exposed.
- **Workloads an attacker may have changed.** A forged frame could have
  started containers or changed state on a node. Re-joining does not inspect
  or clean the host; rebuild a node you do not trust.
- **Volumes.** A volume is recorded against the node that holds it, and the
  re-joined host has a new node ID. This runbook does not move volume
  records; plan a backup and restore for services with volumes.
- **Release signing keys** for the agent and CLI binaries: see "Compromise"
  in [`infra/release-signing.md`](../../infra/release-signing.md).
- **Routine rollovers.** With no suspected compromise, schedule a rollover
  with the default 24-hour delay and complete it once every node shows
  **Ready**; no re-join is needed.
