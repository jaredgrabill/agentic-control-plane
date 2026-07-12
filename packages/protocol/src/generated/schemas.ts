/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */
export const agentCardSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://acp.dev/schemas/v1/agent-card.schema.json",
  "title": "AgentCard",
  "description": "Registry record for one agent version: the team-authored manifest plus platform-managed fields added at registration. A superset of an A2A agent card; card_signature is a JWS over the identity content so consumers can verify provenance.",
  "type": "object",
  "required": [
    "manifest",
    "version",
    "lifecycle_state",
    "registered_at",
    "updated_at",
    "card_signature"
  ],
  "additionalProperties": false,
  "properties": {
    "manifest": {
      "$ref": "agent-manifest.schema.json"
    },
    "version": {
      "type": "string",
      "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z.-]+)?$",
      "description": "Semver of the capability contract, not the implementation."
    },
    "lifecycle_state": {
      "$ref": "#/$defs/lifecycle_state"
    },
    "eval_baseline": {
      "$ref": "eval-report.schema.json#/$defs/eval_baseline",
      "description": "Scores the current active version achieves; gates are relative to this."
    },
    "registered_at": {
      "type": "string",
      "format": "date-time"
    },
    "updated_at": {
      "type": "string",
      "format": "date-time"
    },
    "deployed_at": {
      "type": "string",
      "format": "date-time"
    },
    "state_reason": {
      "type": "string",
      "description": "Why the record is in its current state (e.g. kill-switch reason)."
    },
    "card_signature": {
      "type": "string",
      "description": "Compact JWS over the canonical identity content: {manifest, version, registered_at}. Lifecycle changes do not re-sign."
    }
  },
  "$defs": {
    "lifecycle_state": {
      "type": "string",
      "description": "Full lifecycle vocabulary (agent-lifecycle.md). Registry v0 transitions only among registered/active/suspended; the rest arrive with the Deployment Controller.",
      "enum": [
        "registered",
        "shadow",
        "canary",
        "active",
        "deprecated",
        "suspended",
        "retired"
      ]
    }
  }
} as const;

export const agentManifestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://acp.dev/schemas/v1/agent-manifest.schema.json",
  "title": "AgentManifest",
  "description": "Capability manifest authored by an agent team and versioned in git. A superset of an A2A-compatible agent card; the Registry adds platform-managed fields at registration.",
  "type": "object",
  "required": [
    "id",
    "name",
    "owner",
    "description",
    "capabilities"
  ],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,62}[a-z0-9]$",
      "description": "Stable agent identifier (kebab-case)."
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "owner": {
      "type": "string",
      "minLength": 1,
      "description": "Accountable human team (required — no ownerless agents)."
    },
    "description": {
      "type": "string",
      "minLength": 1
    },
    "capabilities": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/capability"
      }
    },
    "tools": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/tool_binding"
      },
      "description": "MCP servers this agent may bind. Absent means no tool access."
    },
    "models": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "allowed"
      ],
      "properties": {
        "allowed": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string"
          },
          "description": "Model classes (e.g. default-tier), never hard-coded model IDs."
        }
      }
    },
    "data_classification": {
      "$ref": "#/$defs/classification"
    },
    "sla": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "p95_latency_s": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "quality_slo": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        }
      }
    }
  },
  "$defs": {
    "risk_class": {
      "type": "string",
      "enum": [
        "R0",
        "R1",
        "R2",
        "R3"
      ],
      "description": "Side-effect risk: R0 read, R1 draft, R2 write-gated, R3 write-auto."
    },
    "classification": {
      "type": "string",
      "enum": [
        "public",
        "internal",
        "confidential",
        "restricted"
      ]
    },
    "capability": {
      "type": "object",
      "required": [
        "name",
        "description",
        "risk",
        "input_schema",
        "output_schema",
        "examples"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$",
          "description": "Namespaced narrow action, e.g. knowledge.search."
        },
        "description": {
          "type": "string",
          "minLength": 1
        },
        "risk": {
          "$ref": "#/$defs/risk_class"
        },
        "input_schema": {
          "type": "object",
          "description": "JSON Schema 2020-12 for the capability input."
        },
        "output_schema": {
          "type": "object",
          "description": "JSON Schema 2020-12 for the capability output."
        },
        "examples": {
          "type": "array",
          "minItems": 3,
          "items": {
            "type": "object",
            "required": [
              "input"
            ],
            "additionalProperties": false,
            "properties": {
              "input": {
                "type": "object"
              },
              "output": {
                "type": "object"
              },
              "description": {
                "type": "string"
              }
            }
          },
          "description": "At least 3; used for semantic discovery and eval seeds."
        },
        "compensator": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$",
          "description": "Compensating capability for R2+ writes (e.g. change.submit ⇄ change.withdraw). R2/R3 capabilities MUST declare a compensator or irreversible:true — enforced at registration, where the rejection carries an operator-actionable message (conditional JSON Schema keywords do not survive both language bindings)."
        },
        "irreversible": {
          "type": "boolean",
          "description": "Declares an R2+ capability has no compensator; raises approval requirements."
        },
        "experimental": {
          "type": "boolean",
          "description": "Relaxed eval-baseline requirements; shadow-only routing."
        },
        "sla": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "p95_latency_s": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          }
        }
      }
    },
    "tool_binding": {
      "type": "object",
      "required": [
        "server",
        "scopes"
      ],
      "additionalProperties": false,
      "properties": {
        "server": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*$"
        },
        "scopes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]*(:[a-z][a-z0-9_-]*)+$"
          }
        }
      }
    }
  }
} as const;

export const auditEventSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://acp.dev/schemas/v1/audit-event.schema.json",
  "title": "AuditEvent",
  "description": "One record on the append-only audit stream. Carries who (delegation chain), what (action + digests), why (task, policy decision), and with-what (versioned artifacts) for every governable action.",
  "type": "object",
  "required": [
    "event_id",
    "occurred_at",
    "tenant",
    "event_type",
    "actor",
    "action"
  ],
  "additionalProperties": false,
  "properties": {
    "event_id": {
      "$ref": "#/$defs/uuid"
    },
    "occurred_at": {
      "type": "string",
      "format": "date-time"
    },
    "tenant": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}$"
    },
    "event_type": {
      "$ref": "#/$defs/event_type"
    },
    "actor": {
      "type": "object",
      "description": "Who acted, with the full delegation chain from token act claims.",
      "required": [
        "principal"
      ],
      "additionalProperties": false,
      "properties": {
        "principal": {
          "type": "string",
          "minLength": 1,
          "description": "Immediate actor (JWT sub): user, service, or agent-version principal."
        },
        "delegation_chain": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/delegation_link"
          },
          "description": "Outermost first: user → orchestrator → agent → tool, from nested act claims."
        }
      }
    },
    "action": {
      "type": "object",
      "description": "What happened.",
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "description": "Action identifier, e.g. capability or tool action name."
        },
        "inputs_digest": {
          "$ref": "#/$defs/digest"
        },
        "outputs_digest": {
          "$ref": "#/$defs/digest"
        },
        "side_effects": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "reason": {
      "type": "object",
      "description": "Why it was allowed to happen.",
      "additionalProperties": false,
      "properties": {
        "task_id": {
          "$ref": "#/$defs/uuid"
        },
        "step_id": {
          "$ref": "#/$defs/uuid"
        },
        "plan_step": {
          "type": "string"
        },
        "policy": {
          "$ref": "#/$defs/policy_decision"
        }
      }
    },
    "artifacts": {
      "type": "object",
      "description": "With what: every versioned artifact in force at the time, for replay.",
      "additionalProperties": false,
      "properties": {
        "agent_id": {
          "type": "string"
        },
        "agent_version": {
          "type": "string"
        },
        "model": {
          "type": "string"
        },
        "prompt_template_version": {
          "type": "string"
        },
        "lineage_ids": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/uuid"
          },
          "description": "For retrieval events: the exact chunk versions served."
        },
        "workflow_run_id": {
          "type": "string"
        },
        "trace_id": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        }
      }
    },
    "details": {
      "type": "object",
      "description": "Event-type-specific payload (e.g. corpus mutation metadata, lifecycle transition)."
    }
  },
  "$defs": {
    "event_type": {
      "type": "string",
      "description": "Closed vocabulary; extending it is a protocol change.",
      "enum": [
        "task.submitted",
        "task.planned",
        "task.completed",
        "step.dispatched",
        "step.completed",
        "step.skipped",
        "policy.decision",
        "token.issued",
        "token.exchanged",
        "token.brokered",
        "token.denied",
        "bus.auth",
        "agent.registered",
        "agent.lifecycle_changed",
        "agent.baseline_recorded",
        "corpus.mutation",
        "retrieval.served",
        "tool.called",
        "model.invoked",
        "killswitch.activated",
        "killswitch.cleared"
      ]
    },
    "delegation_link": {
      "type": "object",
      "title": "DelegationLink",
      "required": [
        "sub"
      ],
      "additionalProperties": false,
      "properties": {
        "sub": {
          "type": "string",
          "minLength": 1
        },
        "role": {
          "type": "string"
        },
        "scopes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "policy_decision": {
      "type": "object",
      "title": "PolicyDecisionRef",
      "required": [
        "decision",
        "bundle_version"
      ],
      "additionalProperties": false,
      "properties": {
        "decision": {
          "type": "string",
          "enum": [
            "allow",
            "deny",
            "require-approval"
          ]
        },
        "bundle_version": {
          "type": "string",
          "minLength": 1
        },
        "determining_policies": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "IDs of the policies that matched."
        }
      }
    },
    "digest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    }
  }
} as const;

export const evalReportSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://acp.dev/schemas/v1/eval-report.schema.json",
  "title": "EvalReport",
  "description": "One run of an agent's golden eval suite, emitted by an SDK harness (evaluation.md). The report is the evidence; the eval_baseline derived from an accepted run is what the registry records on the agent card and what CI gates against — gates are baseline-relative, never absolute.",
  "type": "object",
  "required": [
    "schema",
    "sdk",
    "agent_id",
    "agent_version",
    "suite",
    "metrics",
    "cases"
  ],
  "additionalProperties": false,
  "properties": {
    "schema": {
      "const": "acp-eval-report/v1"
    },
    "sdk": {
      "type": "string",
      "minLength": 1,
      "description": "Harness that produced the run, e.g. acp-agent-sdk-py@0.1.0 or acp-agent-sdk-ts@0.1.0."
    },
    "agent_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,62}[a-z0-9]$",
      "description": "Stable agent identifier (kebab-case); same pattern as the manifest id."
    },
    "agent_version": {
      "type": "string",
      "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z.-]+)?$",
      "description": "Semver of the capability contract the suite ran against."
    },
    "suite": {
      "$ref": "#/$defs/eval_suite"
    },
    "metrics": {
      "$ref": "#/$defs/eval_metrics"
    },
    "cases": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/eval_case_result"
      },
      "description": "Per-case verdicts in run (golden-file) order."
    },
    "generated_at": {
      "type": "string",
      "format": "date-time"
    }
  },
  "$defs": {
    "unit_interval": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "eval_metrics": {
      "type": "object",
      "title": "EvalMetrics",
      "description": "Gated metrics, all higher-is-better on [0, 1]. Extra domain-specific metrics are allowed and gate like the core three.",
      "required": [
        "pass_rate",
        "citation_precision",
        "abstention_accuracy"
      ],
      "properties": {
        "pass_rate": {
          "$ref": "#/$defs/unit_interval"
        },
        "citation_precision": {
          "$ref": "#/$defs/unit_interval"
        },
        "abstention_accuracy": {
          "$ref": "#/$defs/unit_interval"
        }
      },
      "additionalProperties": {
        "$ref": "#/$defs/unit_interval"
      }
    },
    "eval_suite": {
      "type": "object",
      "title": "EvalSuite",
      "description": "Identity of the golden suite the run scored: a content digest over the case files, so a baseline can refuse comparison when the suite itself changed.",
      "required": [
        "digest",
        "case_count"
      ],
      "additionalProperties": false,
      "properties": {
        "digest": {
          "type": "string",
          "pattern": "^sha256:[0-9a-f]{64}$",
          "description": "sha256 over the sorted *.json case files (basename NUL content NUL per file, CRLF normalized to LF)."
        },
        "case_count": {
          "type": "integer",
          "minimum": 1
        },
        "path": {
          "type": "string",
          "description": "Repo-relative suite directory, informational."
        }
      }
    },
    "eval_case_result": {
      "type": "object",
      "title": "EvalCaseResult",
      "required": [
        "name",
        "passed",
        "abstained",
        "cited_docs",
        "failures"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "passed": {
          "type": "boolean"
        },
        "abstained": {
          "type": "boolean"
        },
        "cited_docs": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "failures": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "eval_baseline": {
      "type": "object",
      "title": "EvalBaseline",
      "description": "Scores an accepted version achieves, distilled from an EvalReport. Recorded on the agent card; CI gates candidate reports against this, relative to per-metric tolerances.",
      "required": [
        "schema",
        "agent_id",
        "agent_version",
        "metrics",
        "suite",
        "harness",
        "recorded_at"
      ],
      "additionalProperties": false,
      "properties": {
        "schema": {
          "const": "acp-eval-baseline/v1"
        },
        "agent_id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,62}[a-z0-9]$"
        },
        "agent_version": {
          "type": "string",
          "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z.-]+)?$"
        },
        "metrics": {
          "$ref": "#/$defs/eval_metrics"
        },
        "suite": {
          "$ref": "#/$defs/eval_suite"
        },
        "harness": {
          "type": "string",
          "minLength": 1,
          "description": "The sdk string of the report the baseline was distilled from."
        },
        "recorded_at": {
          "type": "string",
          "format": "date-time"
        }
      }
    }
  }
} as const;

export const taskContractSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://acp.dev/schemas/v1/task-contract.schema.json",
  "title": "TaskMessage",
  "description": "The task contract: messages exchanged between the Gateway, the Orchestrator, and agents. A task message is exactly one of the four shapes below.",
  "oneOf": [
    {
      "$ref": "#/$defs/task_request"
    },
    {
      "$ref": "#/$defs/task_result"
    },
    {
      "$ref": "#/$defs/step_request"
    },
    {
      "$ref": "#/$defs/step_result"
    }
  ],
  "$defs": {
    "task_request": {
      "type": "object",
      "title": "TaskRequest",
      "description": "A user task as submitted by the Gateway to the Orchestrator, attribution already stamped.",
      "required": [
        "kind",
        "task_id",
        "tenant",
        "principal",
        "input"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "const": "task_request"
        },
        "task_id": {
          "$ref": "#/$defs/uuid"
        },
        "tenant": {
          "$ref": "#/$defs/tenant_id"
        },
        "principal": {
          "type": "string",
          "minLength": 1,
          "description": "Subject of the authenticated caller (JWT sub)."
        },
        "session_id": {
          "$ref": "#/$defs/uuid"
        },
        "input": {
          "type": "object",
          "required": [
            "text"
          ],
          "additionalProperties": false,
          "properties": {
            "text": {
              "type": "string",
              "minLength": 1
            },
            "capability": {
              "$ref": "#/$defs/capability_name",
              "description": "Optional explicit capability route; absent means the orchestrator plans."
            },
            "context": {
              "type": "object"
            }
          }
        },
        "budget": {
          "$ref": "#/$defs/budget"
        },
        "subject_token": {
          "type": "string",
          "description": "The caller's platform JWT, consumed exactly once at intake by the orchestrator's snapshot activity (ADR-0007): verified claims are recorded into durable workflow state and per-step tokens are minted via the broker grant. Its ≤ 15-min TTL no longer bounds task duration."
        },
        "submitted_at": {
          "$ref": "#/$defs/timestamp"
        }
      }
    },
    "task_result": {
      "type": "object",
      "title": "TaskResult",
      "description": "Terminal outcome of a task. Partial results are first-class: gaps are stated, never silently backfilled.",
      "required": [
        "kind",
        "task_id",
        "tenant",
        "status"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "const": "task_result"
        },
        "task_id": {
          "$ref": "#/$defs/uuid"
        },
        "tenant": {
          "$ref": "#/$defs/tenant_id"
        },
        "status": {
          "type": "string",
          "enum": [
            "completed",
            "partial",
            "failed",
            "cancelled"
          ]
        },
        "answer": {
          "$ref": "#/$defs/answer"
        },
        "gaps": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "For partial status: which sub-results are missing and why."
        },
        "error": {
          "$ref": "#/$defs/capability_error"
        },
        "plan": {
          "$ref": "#/$defs/plan"
        },
        "workflow_run_id": {
          "type": "string"
        },
        "completed_at": {
          "$ref": "#/$defs/timestamp"
        }
      }
    },
    "step_request": {
      "type": "object",
      "title": "StepRequest",
      "description": "One delegated step from the Orchestrator to one agent capability, dispatched as a Temporal activity. All state the handler needs is here — handlers are stateless.",
      "required": [
        "kind",
        "step_id",
        "task_id",
        "tenant",
        "agent_id",
        "capability",
        "input"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "const": "step_request"
        },
        "step_id": {
          "$ref": "#/$defs/uuid"
        },
        "task_id": {
          "$ref": "#/$defs/uuid"
        },
        "tenant": {
          "$ref": "#/$defs/tenant_id"
        },
        "agent_id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,62}[a-z0-9]$"
        },
        "agent_version": {
          "type": "string"
        },
        "capability": {
          "$ref": "#/$defs/capability_name"
        },
        "input": {
          "type": "object"
        },
        "delegation_depth": {
          "type": "integer",
          "minimum": 1,
          "description": "1 = delegated directly from the user task; +1 per re-delegation. Platform cap is 3 (agent-patterns.md); exceeding is a planning failure, never a retry."
        },
        "delegated_token": {
          "type": "string",
          "description": "RFC 8693-exchanged JWT: audience = this agent, scopes = intersection, act chain included."
        },
        "budget": {
          "$ref": "#/$defs/budget"
        },
        "trace_context": {
          "$ref": "#/$defs/trace_context"
        }
      }
    },
    "step_result": {
      "type": "object",
      "title": "StepResult",
      "description": "Typed conclusion of a delegated step — a summary, never a transcript.",
      "required": [
        "kind",
        "step_id",
        "task_id",
        "tenant",
        "status"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "const": "step_result"
        },
        "step_id": {
          "$ref": "#/$defs/uuid"
        },
        "task_id": {
          "$ref": "#/$defs/uuid"
        },
        "tenant": {
          "$ref": "#/$defs/tenant_id"
        },
        "status": {
          "type": "string",
          "enum": [
            "completed",
            "failed"
          ]
        },
        "output": {
          "type": "object",
          "description": "Conforms to the capability's declared output_schema."
        },
        "error": {
          "$ref": "#/$defs/capability_error"
        },
        "usage": {
          "$ref": "#/$defs/usage"
        }
      }
    },
    "answer": {
      "type": "object",
      "title": "Answer",
      "description": "Free-text answers ride inside a schema: text + citations + confidence.",
      "required": [
        "text",
        "citations",
        "confidence"
      ],
      "additionalProperties": false,
      "properties": {
        "text": {
          "type": "string"
        },
        "citations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/citation"
          }
        },
        "confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "abstained": {
          "type": "boolean",
          "description": "True when the agent declined to answer below its confidence floor."
        }
      }
    },
    "citation": {
      "type": "object",
      "title": "Citation",
      "required": [
        "doc_id",
        "version",
        "lineage_id"
      ],
      "additionalProperties": false,
      "properties": {
        "doc_id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        },
        "effective_date": {
          "type": "string",
          "format": "date"
        },
        "url": {
          "type": "string"
        },
        "lineage_id": {
          "$ref": "#/$defs/uuid",
          "description": "UUIDv7 ledger key of the exact chunk version served."
        },
        "snippet": {
          "type": "string"
        }
      }
    },
    "capability_error": {
      "type": "object",
      "title": "CapabilityError",
      "description": "Typed failure; the orchestrator's behavior differs per class.",
      "required": [
        "class",
        "message"
      ],
      "additionalProperties": false,
      "properties": {
        "class": {
          "type": "string",
          "enum": [
            "retryable",
            "permanent",
            "budget_exhausted",
            "policy_denied",
            "needs_input"
          ]
        },
        "message": {
          "type": "string",
          "minLength": 1
        },
        "details": {
          "type": "object"
        }
      }
    },
    "budget": {
      "type": "object",
      "title": "Budget",
      "additionalProperties": false,
      "properties": {
        "max_tokens": {
          "type": "integer",
          "minimum": 1
        },
        "max_steps": {
          "type": "integer",
          "minimum": 1
        },
        "max_cost_usd": {
          "type": "number",
          "exclusiveMinimum": 0
        }
      }
    },
    "plan": {
      "type": "object",
      "title": "Plan",
      "description": "Typed plan artifact materialized before execution and recorded to the audit stream (task.planned) — auditors see intent, not just outcomes. v1 plans are flat: no nesting, no mid-course replanning.",
      "required": [
        "plan_id",
        "task_id",
        "tenant",
        "planner",
        "steps",
        "created_at"
      ],
      "additionalProperties": false,
      "properties": {
        "plan_id": {
          "$ref": "#/$defs/uuid"
        },
        "task_id": {
          "$ref": "#/$defs/uuid"
        },
        "tenant": {
          "$ref": "#/$defs/tenant_id"
        },
        "planner": {
          "type": "string",
          "minLength": 1,
          "description": "Planner implementation and version, e.g. rule-planner@1."
        },
        "steps": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": {
            "$ref": "#/$defs/plan_step"
          }
        },
        "rationale": {
          "type": "string"
        },
        "created_at": {
          "$ref": "#/$defs/timestamp"
        }
      }
    },
    "plan_step": {
      "type": "object",
      "title": "PlanStep",
      "required": [
        "step_id",
        "capability",
        "input"
      ],
      "additionalProperties": false,
      "properties": {
        "step_id": {
          "$ref": "#/$defs/uuid"
        },
        "capability": {
          "$ref": "#/$defs/capability_name"
        },
        "agent_id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,62}[a-z0-9]$",
          "description": "Optional pin; absent means registry discovery at dispatch time (kill-switch keeps stopping traffic per step)."
        },
        "input": {
          "type": "object"
        },
        "depends_on": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/uuid"
          },
          "description": "step_ids that must complete successfully first. A failed dependency skips this step (recorded as a gap), never retries the plan."
        },
        "rationale": {
          "type": "string"
        }
      }
    },
    "usage": {
      "type": "object",
      "title": "Usage",
      "additionalProperties": false,
      "properties": {
        "input_tokens": {
          "type": "integer",
          "minimum": 0,
          "description": "Non-cached input tokens only. Cache reads/writes are counted separately below and priced at their own rates; they do NOT count toward max_tokens."
        },
        "output_tokens": {
          "type": "integer",
          "minimum": 0
        },
        "cache_read_tokens": {
          "type": "integer",
          "minimum": 0,
          "description": "Input tokens served from the provider's prompt cache. Priced at the cache-read rate; excluded from max_tokens accounting."
        },
        "cache_write_tokens": {
          "type": "integer",
          "minimum": 0,
          "description": "Input tokens written to the provider's prompt cache (cache creation). Priced at the cache-write rate; excluded from max_tokens accounting."
        },
        "model": {
          "type": "string"
        },
        "llm_calls": {
          "type": "integer",
          "minimum": 0
        },
        "tool_calls": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "trace_context": {
      "type": "object",
      "title": "TraceContext",
      "description": "W3C trace context propagated across bus and workflow hops.",
      "required": [
        "traceparent"
      ],
      "additionalProperties": false,
      "properties": {
        "traceparent": {
          "type": "string",
          "pattern": "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$"
        },
        "tracestate": {
          "type": "string"
        }
      }
    },
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    },
    "tenant_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}$"
    },
    "capability_name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    }
  }
} as const;
