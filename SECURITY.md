# Security policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
<https://github.com/BankkRoll/Open-Rail/security/advisories/new>

Do not open a public issue, pull request, or discussion. Include the affected
component and commit, the impact, and steps to reproduce.

We aim to acknowledge within 3 business days, fix critical and high issues
within 30 days and others within 90, and publish an advisory with the fix.
Reporters are credited unless they ask not to be.

## Supported versions

There is no stable release yet. Fixes land on `main`. For the agent, the latest
`agent-v*` release and the one before it are supported.

## Scope

Test only against an install you run yourself.

In scope:
- **Control plane** (`apps/api`, `apps/web`): authentication, role-based
  access between users and workspaces, secret storage, and the agent
  connection endpoints.
- **Agent** (`agent/`): the join handshake, credential storage, verification of
  signed control messages, and anything that lets a control plane, another
  node, or a workload gain unintended access to a node.
- **Install script** (`install/`): download integrity, signature
  verification, privilege handling.
- **Release pipeline** (`.github/workflows/release-agent.yml`): publishing or
  tampering with agent releases.

Out of scope: vulnerabilities in upstream software (Cloudflare, Docker, etc.),
issues that need an already-compromised operator or node root account unless
they cross a boundary, and scanner output without a working proof of concept.

## Safe harbor

Good-faith research under this policy is authorized. Avoid privacy violations,
data destruction, and service disruption, and give us reasonable time to fix
an issue before disclosing it.
