# Changelog

## [0.2.0](https://github.com/jaredgrabill/agentic-control-plane/compare/agent-sdk-v0.1.0...agent-sdk-v0.2.0) (2026-07-13)


### Features

* **agent-sdk:** carry model id and cache tokens into step usage ([e62eca0](https://github.com/jaredgrabill/agentic-control-plane/commit/e62eca08c53411255ab0e4955f6a3b41b4a34dd2))
* **agent-sdk:** suite digest + eval report payload ([2d8352f](https://github.com/jaredgrabill/agentic-control-plane/commit/2d8352fd5a38ac18406269646510e0f9abbd702d))
* **agent-sdk:** typescript agent SDK alpha ([de143d0](https://github.com/jaredgrabill/agentic-control-plane/commit/de143d0f0d659908e56f0ce2bfc9c61e77a857a3))
* **agent-sdk:** version qualified agent task queues ([8ac0b1e](https://github.com/jaredgrabill/agentic-control-plane/commit/8ac0b1e40cc36093ce6753d989292234788db775))
* **api:** freeze protocol and sdk surface under semver ([4195ed2](https://github.com/jaredgrabill/agentic-control-plane/commit/4195ed25183ca177c443160f9c2476f18e8144bc))
* bind agent sdk model client to the llm gateway ([963ed4c](https://github.com/jaredgrabill/agentic-control-plane/commit/963ed4c1ebea40aae99959f99a25d9c8fdf01401))
* cost meter v0 (versioned price book, max_cost_usd enforcement) ([bd95425](https://github.com/jaredgrabill/agentic-control-plane/commit/bd95425a32ae99596ccf7a37dba0502d8827e14c))
* deployment controller v0 (shadow/canary/promote, versioned registry) ([6427483](https://github.com/jaredgrabill/agentic-control-plane/commit/6427483eb9d2b2b729b4e27be0004caadbb2f3a0))
* evaluation service v0 — baselines on the agent card and the regression gate ([fef45fe](https://github.com/jaredgrabill/agentic-control-plane/commit/fef45fec30615358a96aabfb7a5c5b29513673d3))
* llm gateway v1 (model classes, provider failover, prompt caching) ([d225c0d](https://github.com/jaredgrabill/agentic-control-plane/commit/d225c0d303560c49daac48bd9baafbb7519ecfb7))
* mint session bus identities via nats auth callout ([86cb638](https://github.com/jaredgrabill/agentic-control-plane/commit/86cb638f14d9832f6c29e2ad3b27a0826c8b020c))
* nats auth callout, per-agent identities, acp:tools audience flip ([6ec760d](https://github.com/jaredgrabill/agentic-control-plane/commit/6ec760d562cc400a73cf799d6f5b0ad176669106))
* **p4:** item 5 — operability + OSS 1.0 ([318ae48](https://github.com/jaredgrabill/agentic-control-plane/commit/318ae48a210d9b91231587c499f49676ef31a718))
* TypeScript SDK alpha, create-agent scaffolder, and the cross-SDK parity gate ([348226a](https://github.com/jaredgrabill/agentic-control-plane/commit/348226a9ce051ef5523fe11b317f90fa95b7596e))


### Bug Fixes

* **agent-sdk:** parity-gate hardening — repr quoting, format parity, coercion, NaN guard ([1864fe2](https://github.com/jaredgrabill/agentic-control-plane/commit/1864fe207b248ca09fc90d501a7fabd0eddd73c3))
