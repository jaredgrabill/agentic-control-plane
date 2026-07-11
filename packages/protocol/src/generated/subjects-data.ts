/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */
export const subjectsData = {
  "description": "NATS subject hierarchy: templates and closed verb vocabularies per entity. Tenant is always token 2. Both language bindings render subjects from this file — never from hand-written string concatenation.",
  "version": 1,
  "entities": {
    "task": {
      "template": "acp.{tenant}.task.{task_id}.{verb}",
      "verbs": [
        "submitted",
        "step",
        "completed",
        "failed",
        "cancelled"
      ]
    },
    "agent": {
      "template": "acp.{tenant}.agent.{agent_id}.{verb}",
      "verbs": [
        "dispatch",
        "status"
      ]
    },
    "audit": {
      "template": "acp.{tenant}.audit.{event_type}",
      "verbs": []
    },
    "audit_corpus": {
      "template": "acp.{tenant}.audit.corpus.{source_id}",
      "verbs": []
    },
    "ingest": {
      "template": "acp.{tenant}.ingest.{source_id}",
      "verbs": []
    },
    "telemetry": {
      "template": "acp.{tenant}.telemetry.{signal}",
      "verbs": []
    },
    "registry": {
      "template": "acp.platform.registry.{agent_id}.{verb}",
      "verbs": [
        "registered",
        "updated"
      ]
    },
    "svc": {
      "template": "acp.platform.svc.{service}.{method}",
      "verbs": [],
      "services": [
        "token",
        "registry",
        "policy",
        "knowledge",
        "audit"
      ]
    },
    "control": {
      "template": "acp.platform.control.{verb}",
      "verbs": [
        "killswitch",
        "flags"
      ]
    }
  }
} as const;
