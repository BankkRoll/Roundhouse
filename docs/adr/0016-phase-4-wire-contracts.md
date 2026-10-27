# 0016: Phase 4 wire contracts

## Status

Accepted.
- Date: 2026-10-27
- Implements the protocol parts of 0011 (image push) and 0012 (web shell),
  under the rules of 0014 §15.
- Answers 0015's open question on Phase 4's contracts.

## Context

ADR 0015 left Phase 4's frames (`exec_*`, `image_push`, `edge_gateway`)
to their own contracts pass at version 7, with every credential sealed the
way 0014 requires. 0012 and 0011 were written before 0014, so some of their
frame shapes predate its rules.

## Decision

### Versions

| Version | Phase | Gates (TS `*_PROTOCOL_VERSION`, Go `*ProtocolVersion`) |
| ------- | ----- | ------------------------------------------------------ |
| 7       | 4     | `EXEC`, `IMAGE_PUSH`                                   |

`PROTOCOL_VERSION = 7`; `MIN_PROTOCOL_VERSION` stays 3 for the same reason
as in 0015. `EDGE_GATEWAY` is not defined: Workers VPC is in beta and the
gateway's tunnel token and `desired_state.edge_gateway` need a live account
to design against (0011 "Open questions").

### Frames

| Control → agent                                        | Agent → control                           |
| ------------------------------------------------------ | ----------------------------------------- |
| `exec_open`, `exec_input`, `exec_resize`, `exec_close` | `exec_opened`, `exec_output`, `exec_exit` |
| `image_push`                                           | `image_push_result`                       |

The schemas are in `packages/protocol/src/exec.ts` and `image-push.ts`
(`go/exec.go`, `go/imagepush.go`), with one signed fixture per control
frame and one plain fixture per agent frame.

### Departures from 0011 and 0012

- **No user override.** 0012's `exec_open.user` is dropped: 0014 §15 runs
  every session as the container's configured user. `exec_opened.user`
  reports which user that is, for the dashboard's status line.
- **Sealed keystrokes.** `exec_input.data` becomes `data_sealed`, a box of
  purpose `exec-input` whose AAD binds node, session and `seq`
  (`roundhouse-box:v1:exec-input:<node>:<session>:<seq>`). Input includes
  passwords typed at prompts, so it is a credential under 0014 §6; binding
  `seq` stops a captured batch being replayed at another position.
  `exec_output` is not sealed: agent → control frames have no sealing
  scheme, and output terminates in the Durable Object anyway.
- **Every shell frame is short-lived.** `exec_open`, `exec_input`,
  `exec_resize` and `exec_close` are all in `CREDENTIAL_FRAME_TYPES`, so
  each expires within 60 s, as 0014's merge rules list for `exec_*`.
- **Terminal settings only.** `exec_open.env` accepts `TERM`, `COLORTERM`,
  `LANG`, `LC_ALL` and `LC_CTYPE` (at most 8, each ≤ 256 bytes), not any
  variable: a session must not change how the container's programs load.
- **`command`** is 1 to 32 argv entries of at most 4 KiB in total, without
  NUL bytes, and is never joined into a shell string; the default is the
  fixed `DEFAULT_EXEC_COMMAND`.
- **Close reasons** add `max_duration`, which the relay enforces as well as
  the agent.
- **Image push credentials** move from plain `username`/`password` into
  `credential_sealed` (purpose `image-push`, AAD node and push). The source
  must be pinned by digest in the builder's local registry; the target
  must name a registry host and a tag and must not be the local registry.
  The target host is not restricted to `registry.cloudflare.com`, so the
  agent integration test can push to a local `registry:3`; the control
  plane is the only sender and signs every frame.

## Consequences

- An agent at 7 advertises the shell and push before the control plane
  sends either; both handlers land with the frames in one branch.
- Sealing input costs one X25519 operation per 20 ms batch on each side
  while someone types; an idle session costs nothing.
