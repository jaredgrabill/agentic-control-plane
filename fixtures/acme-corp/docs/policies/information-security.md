# Information Security Policy

**Document ID:** policy/information-security · **Version:** 5.0.1 ·
**Effective:** 2025-11-01 · **Owner:** team-grc · **Classification:** internal

## 1. Scope

Applies to all Acme personnel, contractors, systems, and data.

## 2. Data Classification

Acme classifies information as **public**, **internal**, **confidential**,
or **restricted**. Handling requirements escalate with classification:
restricted data requires encryption at rest and in transit, named-individual
access, and quarterly access recertification.

## 3. Encryption

3.1. All data in transit crosses network boundaries over TLS 1.3 or IPsec.
See the TLS Configuration Standard for cipher and certificate requirements.

3.2. Data at rest in production data stores is encrypted with AES-256;
keys are managed by the central KMS with annual rotation.

## 4. Vulnerability Management

Critical vulnerabilities (CVSS ≥ 9.0 or actively exploited) must be
remediated or mitigated within **72 hours** of triage; high within 14 days;
medium within 90 days. Internet-exposed services with critical
vulnerabilities must be patched under the Emergency change process or taken
offline.

## 5. Access Reviews

System owners review access quarterly. Access not exercised in 90 days is
revoked automatically.

## 6. Incident Reporting

Suspected security incidents must be reported to the Security Operations
Center within one hour of discovery. See the On-Call Escalation Runbook.
