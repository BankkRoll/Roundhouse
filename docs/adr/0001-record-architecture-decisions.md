# 1. Record architecture decisions

- Status: Accepted
- Date: 2026-10-22

## Context

OpenRail spans a Cloudflare Worker control plane, a Go node agent, an install
script, and a wire protocol between them. Decisions in one part constrain the
others, and contributors join at different times. Without a record, the reasons
behind a decision are lost and get relitigated or quietly broken.

## Decision

We record architecturally significant decisions as Architecture Decision Records
in `docs/adr`, in the format described by Michael Nygard in
[Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
- Files are named `NNNN-short-title.md` with a zero-padded, sequential number.
- Each ADR has: title, status, date, context, decision, consequences.
- Status is one of Proposed, Accepted, Deprecated, or Superseded by ADR-NNNN.
- An accepted ADR is not rewritten. To change a decision, write a new ADR that
  supersedes it and update the old one's status line only.
- An ADR is proposed in a pull request and accepted when that PR merges.

A decision is significant if it affects the protocol or its security, data
model or storage, trust boundaries, deployment topology, public APIs, or is
expensive to reverse.

## Consequences

- Reviewers can ask for an ADR when a PR makes a significant decision implicitly.
- New contributors can read `docs/adr` to understand why the system looks the
  way it does.
- Writing an ADR adds some overhead to large changes; small changes do not need
  one.
