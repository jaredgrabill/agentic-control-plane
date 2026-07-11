# TLS Configuration Standard

**Document ID:** standard/tls-configuration · **Version:** 1.6.0 ·
**Effective:** 2026-04-20 · **Owner:** team-platform-eng · **Classification:** internal

## 1. Protocol Versions

TLS 1.3 is required for all new endpoints. TLS 1.2 is permitted only for
documented legacy clients with a retirement date; TLS 1.1 and below are
prohibited and blocked at the load balancer.

## 2. Cipher Suites

TLS 1.3 defaults are acceptable. For TLS 1.2 legacy endpoints, only
ECDHE-based AEAD suites are allowed (ECDHE-ECDSA-AES128-GCM-SHA256,
ECDHE-RSA-AES256-GCM-SHA384, ECDHE-*-CHACHA20-POLY1305).

## 3. Certificates

3.1. Certificates are issued by the internal ACME CA with 90-day validity
and automated rotation; manual issuance requires a Standard change record.

3.2. Key type: ECDSA P-256 preferred; RSA-2048 minimum for legacy.

3.3. Certificate changes on payment-processing endpoints are **Normal
changes** requiring CAB review because client pinning has caused outages
(see incident PAY-2311).

## 4. Internal Traffic

Service-to-service traffic inside the mesh uses mutual TLS with
SPIFFE-issued workload identities. Plaintext internal listeners require a
documented waiver with an expiry.
