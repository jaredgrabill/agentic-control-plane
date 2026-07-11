# Helm Deployment Standard

**Document ID:** standard/deployment-helm · **Version:** 2.1.0 ·
**Effective:** 2026-05-02 · **Owner:** team-platform-eng · **Classification:** internal

## 1. Chart Requirements

Services deploy via the shared `acme-service` Helm chart (current line:
v2.4.x). Charts pin image digests, declare resource requests/limits, and
ship a `values.schema.json`.

## 2. Deployment Steps (core payments microservice example)

1. Merge to `main` triggers CI to publish the image and chart.
2. Staging deploys automatically; smoke suite must pass.
3. Production rollout uses `helm upgrade --atomic --timeout 10m` through
   the deployment pipeline — never from a workstation.
4. Canary at 10% for 30 minutes with automated SLO comparison, then full
   ramp.
5. Rollback is `helm rollback` to the previous release, which the pipeline
   executes automatically on SLO breach.

## 3. Scheduling

Production deploys are Normal changes: they require a change record and
observe change freezes (see Change Management Policy §3). Standard-class
deploys (config-only, pre-approved services) may proceed outside freeze
windows without CAB review.

## 4. Secrets

Charts must not template secrets; workloads read from the vault CSI driver.
