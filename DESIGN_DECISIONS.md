# Design decision log

## ADR-001 - Node built-in HTTP boundary

Context: the assignment needs a local Node backend and reproducible setup. Chosen approach: Node's built-in `http` module with a small router. Alternatives were Express (more convenience, another dependency) and a full framework (more setup than the assignment needs). The built-in boundary keeps startup simple and makes domain code independently testable. Revisit if authentication, streaming, or production deployment becomes a requirement.

## ADR-002 - TypeScript with Vue 3 and Vite

Context: 500 action definitions and cross-module state benefit from static types. Chosen approach: TypeScript for backend/frontend and Vue 3 for the chat UI. Alternatives were JavaScript (less safety) and React (does not meet the requested Vue direction). Vite keeps the UI build small. Validate with `tsc` and the production build.

## ADR-003 - Static catalog declaration with generated registry

Context: the PDF fixes the 50 x 10 shape, but future modules should be addable without rewriting orchestration. Chosen approach: one data declaration parsed into validated definitions and a handler factory. Alternatives were 500 handwritten files (verbose and inconsistent) or dynamic database registration (harder to review). The catalog remains inspectable while core execution is extensible.

## ADR-004 - Module-aware lexical retrieval first

Context: overlapping action names must be resolved without sending all 500 actions to a model. Chosen approach: tokenized lexical retrieval with module/name boosts and bounded candidates; compare against an all-catalog baseline. Alternatives were embeddings (extra runtime/model cost) and hardcoded example mappings (not general). Add a semantic adapter only if benchmark evidence justifies it.

## ADR-005 - Structured plan-and-deterministic execution

Context: final state and failure semantics must be testable while the assignment still requires genuine model-based intent understanding. Chosen approach: the LLM proposes a structured Plan DSL; application code validates, authorizes, executes, and verifies it. Alternatives were hardcoded example routing (not generalizable), single-pass tool calling (weak multi-step control), and model-only execution (cannot prove state changes).

## ADR-006 - Shared store plus domain rules

Context: 500 actions need meaningful behavior without 500 duplicated persistence layers. Chosen approach: a shared in-memory store with generic CRUD/search plus specialist transition/relationship rules. Alternatives were a universal success stub (fails requirements) or 50 separate databases (unnecessary). The store is replaceable behind a small port.

## ADR-007 - Confirmation metadata enforced by backend

Context: destructive, externally visible, fan-out/bulk, and financial operations need safety. Chosen approach: action metadata declares confirmation, and the engine blocks execution server-side until a read-first preview, plan hash, and confirmation token are supplied. The UI provides explicit confirm and cancel controls. Automated fixtures supply the token/hash for deterministic end-to-end evaluation.

## ADR-008 - Sequential dependency execution with bounded retries

Context: workflows use prior outputs and must avoid duplicate side effects. Chosen approach: dependency-ordered sequential execution; safe reads may retry once, non-idempotent mutations do not. Parallel execution is an optimization for independent reads but would complicate deterministic traces and is deferred until measured need.

## ADR-009 - Synthetic deterministic evaluation

Context: no real API credentials are required and benchmark results must be reproducible. Chosen approach: seeded state, fixed scenarios, actual state assertions, and estimated deterministic token/cost fields. External provider latency/cost remains `NOT_MEASURED`. Revisit when a provider/model is configured.

## ADR-010 - Bounded provider-backed planner with offline mode

Context: the assignment asks for an LLM provider and agent orchestration, but local regression tests must work without credentials and must not send all 500 actions on every request. Chosen approach: a provider adapter receives only bounded retrieved candidates and returns a structured Plan DSL document. Safe read-only requests may use a deterministic fallback after provider failure; state-changing fallback plans fail closed. Schemas, confirmation, permissions, state transitions, and final response remain authoritative. Provider error reasons and usage are recorded when available; subscription allowance runs remain cost-unpriced rather than fabricated as USD.

## ADR-011 - SSE progress plus idempotency keys

Context: a final response-only API does not provide useful workflow progress and repeated network requests can duplicate mutations. Chosen approach: `/api/chat/stream` emits step-level SSE events, and clients may send an idempotency key cached per session. Alternatives were polling (more latency and state endpoints) and blind server retries (unsafe for mutations). Revisit if a durable queue or multi-instance deployment requires shared idempotency storage.

## ADR-012 - Declarative workflow fan-out and exclusion

Context: complex prompts require outputs from one action to control later actions. Chosen approach: `PlanStep` declares `forEachFrom`, `excludeBy`, and `excludeField`; the executor performs generic dataflow and the handlers remain domain-focused. This is preferable to hardcoding each example prompt because it preserves extension points while keeping filtering deterministic.

## ADR-013 - Structured LLM planning with deterministic execution

Context: a deterministic parser alone does not satisfy the AI nature of the assignment, while a model-controlled executor cannot guarantee state correctness. Chosen approach: retrieve bounded action candidates, ask the provider for a structured Plan DSL document, validate it with Zod and an action allowlist, then execute through the existing deterministic registry. The provider is never allowed to mutate state directly.

## ADR-014 - Offline and provider-backed modes

Context: provider credentials are not available in every development or evaluation environment. Chosen approach: offline mode uses the deterministic fallback and is clearly labeled; provider-backed mode uses real structured planning and records model metrics. Offline benchmarks cannot be presented as provider quality or cost measurements.

## ADR-015 - Retrieval evolves by measurement

Context: semantic embeddings can improve paraphrase recall but add model, indexing, and cost complexity. Chosen approach: establish a lexical/BM25 baseline and add hybrid embeddings only when a dev-set miss analysis demonstrates a measurable benefit. No speed or cost improvement is claimed before measurement.

## ADR-016 - LangGraph around planner state only

Context: the assignment requires an agent/orchestration library, but domain state changes must remain auditable and deterministic. Chosen approach: LangGraph coordinates the provider planner's `generate -> validate -> end` state transitions. The graph receives candidate metadata and working context, but never a store port and never executes handlers. The registry executor remains the only mutation boundary. This gives the system a real orchestration layer without allowing model or framework code to bypass safety policy.
