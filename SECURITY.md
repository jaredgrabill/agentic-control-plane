# Security Policy

## Supported Versions

This project is pre-1.0. Only the latest minor release receives security
fixes. Once 1.0 ships, the two most recent minor versions will be supported.

| Version | Supported |
|---|---|
| latest minor (pre-1.0) | ✅ security fixes |
| ≥ 1.0, two most recent minors | ✅ security fixes (post-1.0) |
| older | ❌ upgrade to a supported minor |

Version support follows the SemVer policy in
[docs/standards/api-versioning.md](docs/standards/api-versioning.md); an
in-support release always has a documented, non-breaking upgrade path
([rolling-upgrade runbook](docs/runbooks/upgrade-rolling.md)).

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

### Response SLA

| Stage | Target |
|---|---|
| Acknowledgement of report | 3 business days |
| Triage + severity assessment | 10 business days |
| Fix for a Critical/High in a supported version | 30 days (or a documented mitigation) |
| Coordinated public disclosure | 90 days by default, negotiable with the reporter |

Fixes ship to every supported version (see the table above). Advisories are
published via GitHub Security Advisories with a CVE where applicable, and
credited to the reporter unless anonymity is requested.

## Support

- **Usage questions:** GitHub Discussions / issues.
- **Security reports:** the private channel above — never a public issue.
- **Operational runbooks** (kill switch, upgrade, backup/restore, DR) live
  under [docs/runbooks/](docs/runbooks/README.md).

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
