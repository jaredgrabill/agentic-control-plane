# Changelog

## [0.2.0](https://github.com/jaredgrabill/agentic-control-plane/compare/protocol-v0.1.0...protocol-v0.2.0) (2026-07-13)


### Features

* add broker-time denylist checks to token service ([e673872](https://github.com/jaredgrabill/agentic-control-plane/commit/e673872f17c94c10796da537f55014b5cdd25536))
* add model.invoked audit event ([d964413](https://github.com/jaredgrabill/agentic-control-plane/commit/d9644130ae00c5ecdee7d014bd0459a68c8f40da))
* agent registry v0 — signed cards, lifecycle states, announcements, KV cache ([e99bbbb](https://github.com/jaredgrabill/agentic-control-plane/commit/e99bbbbc9ffde2a1e479558c71964f7e4ccb346e))
* approval machinery (three-way cedar, ApprovalWorkflow, api + cli) ([ea77527](https://github.com/jaredgrabill/agentic-control-plane/commit/ea7752762e17ca7a085b2de9bd8a8e7e7b0dd2d0))
* bind agent sdk model client to the llm gateway ([963ed4c](https://github.com/jaredgrabill/agentic-control-plane/commit/963ed4c1ebea40aae99959f99a25d9c8fdf01401))
* compensation (saga stacks, cancellation, registration rules) ([cd90ed8](https://github.com/jaredgrabill/agentic-control-plane/commit/cd90ed81cf85a71ee88c8e38032b4903eb678511))
* cost meter v0 (versioned price book, max_cost_usd enforcement) ([bd95425](https://github.com/jaredgrabill/agentic-control-plane/commit/bd95425a32ae99596ccf7a37dba0502d8827e14c))
* deployment controller v0 (shadow/canary/promote, versioned registry) ([6427483](https://github.com/jaredgrabill/agentic-control-plane/commit/6427483eb9d2b2b729b4e27be0004caadbb2f3a0))
* docker-compose dev stack, make dev, and acme-corp fixture corpus v0 ([790810b](https://github.com/jaredgrabill/agentic-control-plane/commit/790810babf15247992c5f5db39fa6999c733e90b))
* evaluation service v0 — baselines on the agent card and the regression gate ([fef45fe](https://github.com/jaredgrabill/agentic-control-plane/commit/fef45fec30615358a96aabfb7a5c5b29513673d3))
* **gateway:** reserve tenant budget at task intake ([2a137d4](https://github.com/jaredgrabill/agentic-control-plane/commit/2a137d4f415ad49e78a1ecbb647aa8e4c23be7f9))
* llm gateway v1 (model classes, provider failover, prompt caching) ([d225c0d](https://github.com/jaredgrabill/agentic-control-plane/commit/d225c0d303560c49daac48bd9baafbb7519ecfb7))
* monorepo scaffold with protocol package and dual-language bindings ([5e26580](https://github.com/jaredgrabill/agentic-control-plane/commit/5e265805e0d29c5b1e867fd3eaeb8d8a4d47be5d))
* monorepo scaffold with protocol package and dual-language bindings ([0709b68](https://github.com/jaredgrabill/agentic-control-plane/commit/0709b68d631f2e79757feaeb159519b0dc0fe654))
* nats auth callout, per-agent identities, acp:tools audience flip ([6ec760d](https://github.com/jaredgrabill/agentic-control-plane/commit/6ec760d562cc400a73cf799d6f5b0ad176669106))
* online evaluation v0 (calibrated judge, probes, drift, error budgets) ([ec052ba](https://github.com/jaredgrabill/agentic-control-plane/commit/ec052bac1b00f740ef37d6de1dc4f0b26e4f38e1))
* orchestrator v0 — TaskWorkflow/AgentStepWorkflow, policy-gated polyglot dispatch ([9fa6e83](https://github.com/jaredgrabill/agentic-control-plane/commit/9fa6e8358320618f820d9049093098bee2f045e4))
* orchestrator v1 — plan-then-execute, fan-out, budgets, depth cap, identity broker (ADR-0007) ([2f6edfd](https://github.com/jaredgrabill/agentic-control-plane/commit/2f6edfdb7b36720010fc57f00543da0cad9defe3))
* **p4:** item 4 — session context cache ([0fbf9ab](https://github.com/jaredgrabill/agentic-control-plane/commit/0fbf9ab210ffd0f754aad435311c305b38306a4e))
* **p4:** item 5 — operability + OSS 1.0 ([318ae48](https://github.com/jaredgrabill/agentic-control-plane/commit/318ae48a210d9b91231587c499f49676ef31a718))
* phase 0+1 — walking skeleton (stack completion into main) ([ade00cc](https://github.com/jaredgrabill/agentic-control-plane/commit/ade00ccce9c1f2e6bab8d189a51b21b13ad362ac))
* **protocol:** add a2a agent card and tool-server schemas ([3c6448f](https://github.com/jaredgrabill/agentic-control-plane/commit/3c6448f84c196becfb892e205093755ab528bdf4))
* **protocol:** add approval audit event types ([0b64a8b](https://github.com/jaredgrabill/agentic-control-plane/commit/0b64a8bc407e500eb9dd6ec6b0e6cdb27d8e1165))
* **protocol:** add cache token fields to usage ([00428d2](https://github.com/jaredgrabill/agentic-control-plane/commit/00428d2b77de2443590acf0b595aeece0140ff1d))
* **protocol:** add compensation audit events and task result compensation block ([50d421f](https://github.com/jaredgrabill/agentic-control-plane/commit/50d421fcf2bb2cd6ca23c377fc6005ec98f17322))
* **protocol:** add deployment audit events ([61b3e33](https://github.com/jaredgrabill/agentic-control-plane/commit/61b3e339d09473c57bc2d69d141f32cabcd25e7f))
* **protocol:** add online evaluation audit events ([7a1ddd9](https://github.com/jaredgrabill/agentic-control-plane/commit/7a1ddd9fc1023cfee6a850bc574675fd256d33c7))
* **protocol:** add schema-diff breaking-change gate and baseline ([cef0735](https://github.com/jaredgrabill/agentic-control-plane/commit/cef0735b5628784197d3e21fa29f5e802b9735bb))
* **protocol:** pin eval report and baseline shapes ([1500ce9](https://github.com/jaredgrabill/agentic-control-plane/commit/1500ce907bd8954801a65034c7d81da498227608))
* **protocol:** plan artifacts, delegation depth, broker/plan audit events ([311b196](https://github.com/jaredgrabill/agentic-control-plane/commit/311b196d9687ccc9a53d36f03e0350c9cec9511c))
* **protocol:** tool.called audit event ([bf42633](https://github.com/jaredgrabill/agentic-control-plane/commit/bf42633baa86fe0de79da3473537cb2a5666da27))
* tool gateway v1 and the knowledge corpus behind standard MCP ([bd6fdc8](https://github.com/jaredgrabill/agentic-control-plane/commit/bd6fdc8195901aed397921cea1cab007f62e0475))


### Bug Fixes

* **p4:** consolidated fable code-review follow-ups ([594cc07](https://github.com/jaredgrabill/agentic-control-plane/commit/594cc073019766a71c90ac871e1218b8f9fbf1c4))
* **protocol:** schema-diff flags newly-added field constraints ([bad2c69](https://github.com/jaredgrabill/agentic-control-plane/commit/bad2c69173deeed198fb724113571f158034dacf))
