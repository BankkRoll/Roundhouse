# openrail-agent

Runs on each server. Dials out to the control plane over WebSocket, reports
heartbeats, and applies the desired state the control plane sends.

## Build

```sh
go build -o bin/openrail-agent ./cmd/openrail-agent
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bin/openrail-agent-linux-arm64 ./cmd/openrail-agent
```

## Use

```sh
openrail-agent join --url https://<control-plane> --token <token> [--name <name>]
openrail-agent run
openrail-agent version
```

On servers, use `install/install.sh`, which also sets up Docker and systemd.

| Flag           | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `--config`     | Config path (default `/etc/openrail/agent.yaml`)               |
| `--data-dir`   | Credential, identity key, state (default `/var/lib/openrail`)  |
| `--token-file` | Read the join token from a file instead of argv                |
| `--force`      | Re-join; the old registration is kept intact if the join fails |
| `--insecure`   | Allow http/ws to a non-loopback host. Development only.        |

## Distribution

Signed GitHub releases (`agent-v*` tags) are the only distribution channel;
`install/install.sh` downloads and verifies them. `go install ...@version`
does not work, because `go.mod` uses a `replace` directive to build against the
protocol module in this repository.

## Test

```sh
go test ./...
go vet ./...
```

## Notes

- Control messages are Ed25519-signed. The agent verifies the bytes before
  parsing, and rejects messages for another node or past expiry (60s grace,
  corrected for clock skew).
- If disconnected, the agent keeps running current workloads and reconnects
  with backoff.
- Container reconciliation is not implemented yet. `desired_state` is recorded
  but not applied.
