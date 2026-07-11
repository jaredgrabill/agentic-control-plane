# Access Control Policy

**Document ID:** policy/access-control · **Version:** 4.1.0 ·
**Effective:** 2026-02-10 · **Owner:** team-grc · **Classification:** confidential

## 1. Principles

Least privilege, need-to-know, and separation of duties. All access is
identity-based; shared accounts are prohibited.

## 2. Authentication

2.1. Production access requires SSO with phishing-resistant MFA (FIDO2).

2.2. Service-to-service authentication uses short-lived, audience-bound
credentials issued by the central identity provider; static API keys are
prohibited in new systems and must be retired from existing systems by
2026-12-31.

## 3. Privileged Access

Privileged sessions require just-in-time elevation with a stated reason,
are time-boxed to four hours, and are session-recorded. Standing
administrative access is prohibited.

## 4. Emergency Access

Break-glass accounts exist per critical system, sealed in the vault, with
use alarmed to the SOC and reviewed within 24 hours.

## 5. Non-Human Identities

Automated agents and service accounts are first-class identities: each has
a named human owner, scoped permissions reviewed quarterly, and credentials
that expire within 15 minutes of issuance where technically feasible.
