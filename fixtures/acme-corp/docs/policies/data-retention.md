# Data Retention and Disposal Policy

**Document ID:** policy/data-retention · **Version:** 2.4.0 ·
**Effective:** 2026-03-01 · **Owner:** team-grc · **Classification:** internal

## 1. Retention Schedule

| Data category | Retention | Disposal |
| --- | --- | --- |
| Financial records | 7 years | Certified destruction |
| Change records | 7 years | Certified destruction |
| Audit logs (security-relevant) | 18 months hot, 7 years archival | Crypto-shredding |
| Application logs | 90 days | Automated deletion |
| Customer PII | Duration of contract + 3 years | Crypto-shredding |
| Backups | 35 days rolling | Automated expiry |

## 2. Legal Holds

Data subject to a legal hold is exempt from scheduled disposal until the
hold is released by Legal. Holds override every other provision of this
policy.

## 3. Erasure Requests

Verified data-subject erasure requests are honored within 30 days by
crypto-shredding the subject's encryption keys; ledgered systems retain
encrypted, unrecoverable records to preserve integrity chains.

## 4. System Owner Duties

Each system of record declares its data categories and enforces the
schedule mechanically (lifecycle rules, partition drops). Annual attestation
is required.
