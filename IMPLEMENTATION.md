# Implementation plan

## Repository structure

```text
backend/src/catalog.ts       exact 50 x 10 catalog
backend/src/types.ts         schemas, traces, errors, store ports
backend/src/store.ts         deterministic synthetic state
backend/src/registry.ts      validation and all 500 handlers
backend/src/retrieval.ts     bounded retrieval; hybrid semantic search is a measured extension
backend/src/plan.ts          validated Plan DSL and provider candidate allowlist
backend/src/planner.ts       provider-backed structured planner boundary
backend/src/agent_graph.ts   LangGraph planner state transitions
backend/src/engine.ts        context, planning, execution, metrics, offline fallback
backend/src/server.ts        Node HTTP API and static serving
frontend/src/App.vue         chat product surface
frontend/src/main.ts         Vue bootstrap
frontend/src/styles.css      UI styling
tests/                       invariant and behavioral tests
evaluation/                  100+ scenarios and benchmark output
```

## Phases and dependencies

1. Requirements and traceability: extract both PDFs, create living documentation, and encode the catalog.
2. Domain foundation: types, deterministic store, seed/reset, catalog validation.
3. Execution: registry handlers, retrieval, structured planning, workflow plans, confirmation and traces.
4. Product surface: API and Vue chat UI.
5. Verification: invariant tests, state mutation tests, failure/confirmation tests, 100+ scenarios, 500-handler smoke test.
6. Benchmark and review: baseline vs optimized retrieval, latency/quality/cost report, documentation audit.

## Commands

```bash
npm install
npm run dev       # Vite UI + Node API in development
npm test          # typecheck and automated tests
npm run evaluate  # reproducible scenario benchmark
npm run build     # frontend and backend production build
npm start         # serve built app on PORT (default 8787)
```

The only required runtime configuration for offline development is `PORT`. The provider-backed AI path uses `ASK_AI_LLM_API_KEY` or `OPENAI_API_KEY`, with `ASK_AI_MODEL` and `ASK_AI_LLM_ENDPOINT` overrides. Offline mode is for reproducibility; it is not the provider-backed benchmark.

## Action schema and registration

`ActionDefinition` contains `id`, `moduleId`, `moduleName`, `name`, `description`, `inputSchema`, `outputSchema`, `operation`, `confirmation`, and `handler`. `createRegistry()` asserts 50 modules, ten actions/module, unique IDs, nonempty schemas, and callable handlers at startup. The provider receives only bounded candidates and returns a structured Plan DSL document. `plan.ts` validates its shape, candidate allowlist, dependencies, and references before the executor can run it.

The handler factory applies common semantics for create/get/search/update/delete/archive and specialist semantics for status transitions, relationships, messaging, scheduling, payments, refunds, publishing, quote conversion, payment allocation, and access management. Every handler returns records from the store or a typed domain error. Workflow steps support dependency-aware fan-out and exclusion by relationship field.

## Testing strategy

- registry invariants: exactly 500 callable actions;
- seed/reset reproducibility;
- every handler smoke test with generated valid inputs;
- mutation observability after create/update/transition;
- invalid IDs, missing fields, invalid transitions, and confirmation gates;
- follow-up context and multi-step dependency traces;
- partial failure and unsupported request behavior;
- retry-once and idempotency-key behavior;
- server-sent progress events;
- 100+ evaluation scenarios across every module.
- provider-backed planner contract tests with a fake provider;
- LangGraph planner graph contract coverage;
- explicit separation of offline deterministic and live provider metrics.

## Completion checklist

- [x] Source PDFs read and catalog encoded.
- [x] Backend and frontend run locally with a clean install.
- [x] 50 modules and exactly 500 handlers pass startup assertions.
- [x] State changes are observable and reset is reproducible.
- [x] Direct, indirect, complex, follow-up, ambiguity, unsupported, and failure behavior pass tests.
- [x] 100+ scenarios and the 500-handler smoke test pass.
- [x] Offline baseline/optimized metrics are measured and documented honestly.
- [x] Provider-backed planner uses a real structured Plan DSL and LangGraph state-transition graph.
- [x] Provider benchmark harness compares full-catalog baseline versus bounded optimized mode; real metrics remain credential-dependent.
- [x] Add generic Plan DSL operations (`filter`, `exclude`, `join`, `count`, `sort`, and `limit`) for provider plans.
- [x] Remove the example-specific workflow branches from the offline fallback.
- [x] Add read-first previews, plan-hash confirmation, relative date resolution, and entity resolution.
- [ ] Run provider-backed benchmark with real tokens, latency, pricing, and cache behavior.
- [x] README and all required engineering documents match the actual code.
