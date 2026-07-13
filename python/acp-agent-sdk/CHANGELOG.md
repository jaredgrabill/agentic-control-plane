# Changelog

## [0.2.0](https://github.com/jaredgrabill/agentic-control-plane/compare/acp-agent-sdk-v0.1.0...acp-agent-sdk-v0.2.0) (2026-07-13)


### Features

* **acp-agent-sdk:** suite digest + eval report payload ([b063afb](https://github.com/jaredgrabill/agentic-control-plane/commit/b063afbd0c7f8d28e0d7dbf91aef96ea236a936a))
* **agent-sdk:** carry model id and cache tokens into step usage ([e62eca0](https://github.com/jaredgrabill/agentic-control-plane/commit/e62eca08c53411255ab0e4955f6a3b41b4a34dd2))
* **agent-sdk:** version qualified agent task queues ([8ac0b1e](https://github.com/jaredgrabill/agentic-control-plane/commit/8ac0b1e40cc36093ce6753d989292234788db775))
* bind agent sdk model client to the llm gateway ([963ed4c](https://github.com/jaredgrabill/agentic-control-plane/commit/963ed4c1ebea40aae99959f99a25d9c8fdf01401))
* cost meter v0 (versioned price book, max_cost_usd enforcement) ([bd95425](https://github.com/jaredgrabill/agentic-control-plane/commit/bd95425a32ae99596ccf7a37dba0502d8827e14c))
* deployment controller v0 (shadow/canary/promote, versioned registry) ([6427483](https://github.com/jaredgrabill/agentic-control-plane/commit/6427483eb9d2b2b729b4e27be0004caadbb2f3a0))
* evaluation service v0 — baselines on the agent card and the regression gate ([fef45fe](https://github.com/jaredgrabill/agentic-control-plane/commit/fef45fec30615358a96aabfb7a5c5b29513673d3))
* knowledge agent v0, kill switch tier 1, and the phase 1 exit scenario E2E ([bf9f206](https://github.com/jaredgrabill/agentic-control-plane/commit/bf9f2063973ed3c731f8bdff66a1c0a70ffe0a31))
* llm gateway v1 (model classes, provider failover, prompt caching) ([d225c0d](https://github.com/jaredgrabill/agentic-control-plane/commit/d225c0d303560c49daac48bd9baafbb7519ecfb7))
* mint session bus identities via nats auth callout ([86cb638](https://github.com/jaredgrabill/agentic-control-plane/commit/86cb638f14d9832f6c29e2ad3b27a0826c8b020c))
* nats auth callout, per-agent identities, acp:tools audience flip ([6ec760d](https://github.com/jaredgrabill/agentic-control-plane/commit/6ec760d562cc400a73cf799d6f5b0ad176669106))
* **p4:** item 0 — phase 3 consolidation debts ([a146f57](https://github.com/jaredgrabill/agentic-control-plane/commit/a146f579ed86deddaa5dfd9d316e81d65c88e97e))
* phase 0+1 — walking skeleton (stack completion into main) ([ade00cc](https://github.com/jaredgrabill/agentic-control-plane/commit/ade00ccce9c1f2e6bab8d189a51b21b13ad362ac))
* python SDK alpha and acp-create-agent scaffolder ([39a2190](https://github.com/jaredgrabill/agentic-control-plane/commit/39a219070793ea89a0877e6ac0436c74f5285e2e))
* TypeScript SDK alpha, create-agent scaffolder, and the cross-SDK parity gate ([348226a](https://github.com/jaredgrabill/agentic-control-plane/commit/348226a9ce051ef5523fe11b317f90fa95b7596e))


### Bug Fixes

* **acp-agent-sdk:** allow golden cases to expect typed failures ([5719c30](https://github.com/jaredgrabill/agentic-control-plane/commit/5719c30f2fe2d4b14b95dff2c5d52c7917b37736))
* **acp-agent-sdk:** suite_digest raises on missing directory ([a2ed6d7](https://github.com/jaredgrabill/agentic-control-plane/commit/a2ed6d7400e887e582841a35f422b064f97da480))
* **agent-sdk:** parity-gate hardening — repr quoting, format parity, coercion, NaN guard ([1864fe2](https://github.com/jaredgrabill/agentic-control-plane/commit/1864fe207b248ca09fc90d501a7fabd0eddd73c3))
* require killswitch, python ajv parity, trim class enumeration ([bebea76](https://github.com/jaredgrabill/agentic-control-plane/commit/bebea766066d7ea36d84fb269c4dfa9606622233))
