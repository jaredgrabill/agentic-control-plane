# Change Management Policy

**Document ID:** policy/change-management · **Version:** 3.2.0 ·
**Effective:** 2026-01-15 · **Owner:** team-grc · **Classification:** internal

## 1. Purpose

This policy governs how changes to Acme production systems are proposed,
assessed, approved, implemented, and reviewed. It applies to all production
infrastructure, applications, network devices, and data stores.

## 2. Change Classes

| Class | Definition | Approval |
| --- | --- | --- |
| Standard | Pre-approved, low-risk, repeatable (e.g. certificate rotation) | Automatic, logged |
| Normal | Planned changes with assessed risk | Change Advisory Board (CAB) |
| Emergency | Restores service or closes an actively exploited vulnerability | Emergency CAB (two senior approvers) |

## 3. Change Freezes

A **change freeze** is a period during which Normal and Standard changes to
production systems are suspended.

3.1. A change freeze is in effect during the **final week of each fiscal
quarter** and during the **annual holiday freeze from December 18 through
January 2**.

3.2. Additional freezes may be declared by the VP of Engineering or the
Chief Information Security Officer for major business events (e.g. the
annual sales event) with at least five business days' notice.

3.3. During a freeze, only **Emergency changes** may proceed, and they
require Emergency CAB approval plus explicit sign-off from the on-call
engineering director. The change record must reference the incident or
vulnerability that justifies the exception.

3.4. Changes already in progress when a freeze begins must be completed or
rolled back before the freeze takes effect; they may not remain in a
partially applied state through the freeze window.

3.5. Freeze periods are published on the engineering calendar at least one
quarter in advance and announced in #eng-announcements.

## 4. Change Records

Every Normal and Emergency change requires a change record containing: the
implementation plan, rollback plan, blast-radius assessment, affected
configuration items, and scheduled window. Records are retained for seven
years per the Data Retention and Disposal Policy.

## 5. Conflict Detection

Changes touching the same configuration items within overlapping windows
must be flagged and serialized. The change calendar is the source of truth
for scheduling conflicts.

## 6. Post-Implementation Review

Failed or rolled-back changes require a post-implementation review within
five business days, and the findings feed the risk assessment of subsequent
similar changes.
