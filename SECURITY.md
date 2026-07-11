# Security Policy

## Supported Versions

This project is pre-1.0. Only the latest minor release receives security
fixes. Once 1.0 ships, the two most recent minor versions will be supported.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repository Security tab). If that is not
possible, email the maintainers at the address listed in the README.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if available)
- Affected component and version/commit
- Any suggested remediation

We will acknowledge reports within **3 business days**, provide a triage
assessment within **10 business days**, and coordinate a disclosure timeline
with you. We follow a 90-day coordinated disclosure window by default.

## Scope Notes for an Agentic Platform

Because this project orchestrates AI agents that call tools with real-world
side effects, we treat the following as security vulnerabilities (not just
quality issues) and they qualify for private reporting:

- Prompt-injection paths that escalate an agent's effective permissions
- Bypasses of policy-engine decisions (allow/deny/approval gates)
- Tenant isolation failures in messaging subjects, vector storage, or audit
  trails
- Token/credential leakage between agents, tools, or tenants
- Audit-trail tampering or evasion (actions that do not produce audit records)
- Kill-switch or deactivation bypasses

## Hardening Guidance

Deployment hardening guidance lives in
[docs/architecture/security.md](docs/architecture/security.md).
