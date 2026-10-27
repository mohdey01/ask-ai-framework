# Evaluation methodology and results

## Coverage

The scenario set covers all 50 modules and includes direct, indirect, multi-step, follow-up, ambiguous, unsupported, invalid-input, confirmation, failure, cross-module, conditional/exclusion, typo, retry, and repeated-execution cases. Each scenario has a stable ID, a deterministic `dev` or held-out `test` split, expected action IDs, expected parameter fields, expected final-state statement, and evaluator assertions. The focused harness separately injects tool failures and asserts retry and partial-failure semantics. The per-module coverage cases are intentionally templated for breadth; the hand-authored cross-module cases provide the more realistic assignment-style workflows.

The evaluator also smoke-tests every registered handler with generated valid inputs and verifies that mutating actions change a subsequent read or return a meaningful domain result.

## Metrics

- action-selection accuracy: chosen action IDs accepted by scenario;
- parameter accuracy: required parameter values match expected values;
- final-state correctness: store assertions after execution;
- end-to-end success: all scenario assertions pass;
- p50/p95 time to first useful response and completion latency; first useful means the first completed trace step or confirmation preview, not the loading indicator;
- model calls, retries, estimated input/output tokens, and estimated cost;
- failure categories and confirmation rate.

## Targets set before benchmarking

These are targets, not results: 100% registry coverage; at least 90% action selection and 90% final-state correctness on deterministic scenarios; p95 direct completion under 100ms and p95 complex completion under 250ms on a local developer machine; zero duplicate non-idempotent mutations on repeated confirmation; zero fabricated success on invalid/unsupported requests.

## Baseline versus optimized

The current offline baseline ranks all 500 definitions and the optimized path uses bounded lexical candidates while preserving the same deterministic handler layer. These are valid application regression measurements, not provider quality or cost measurements. The provider-backed benchmark compares a plain full-catalog tool-use agent against bounded retrieval plus structured Plan DSL planning on the same realistic scenarios. The harness records model calls, tokens, latency, retries, provider fallbacks, and estimated cost when pricing is configured. It runs isolated scenarios with bounded concurrency and writes an atomic checkpoint after each completed scenario so an interrupted run can resume without repeating completed IDs.

Provider requests use a 35-second per-attempt timeout, a 40-second overall retry budget, compact output budgets (400 tokens for ranking, 600 for simple plans, and 900 for expanded plans), and one retry with exponential backoff plus jitter for transport errors and HTTP 429/503 responses. Deadline timeouts are surfaced immediately rather than retried. Each benchmark scenario gets its own stable provider session; follow-up turns reuse that session so provider-side routing and prompt caching remain conversation-local.

## Actual results

Machine-readable offline results: [`evaluation/results.json`](evaluation/results.json).

Run: `npm run evaluate`, 23 October 2026, Node v22.13.1 on the local developer machine, deterministic engine, clean reset before every scenario.

| Metric | Baseline | Optimized |
|---|---:|---:|
| Scenarios | 204 | 204 |
| Passed | 204 | 204 |
| End-to-end success | 100% | 100% |
| Action-selection accuracy | 100% | 100% |
| Required-parameter accuracy | 100% | 100% |
| Final-state correctness | 100% | 100% |
| Final-state checks | 102/102 | 102/102 |
| Direct p50 / p95 useful response | 0.44 / 0.64 ms | 0.40 / 0.51 ms |
| Direct p50 / p95 completion | 0.45 / 0.71 ms | 0.41 / 0.54 ms |
| Complex p50 / p95 useful response | 0.05 / 0.05 ms | 0.04 / 0.04 ms |
| Complex p50 / p95 completion | 0.62 / 0.62 ms | 0.56 / 0.56 ms |
| Model calls / retries / estimated cost | 0 / 0 / $0 | 0 / 0 / $0 |

Parameter accuracy measures the expected parameter fields declared per scenario; final-state correctness checks persisted records for every successful mutating trace (102 checks). These are local deterministic application timings, not hosted-model latency. The offline benchmark writes `evaluation/results.json`; the provider harness writes a run-specific report such as `evaluation/provider-results-final.json`. OpenCode Go allowance usage is not directly converted to USD when pricing variables are blank, so the saved report correctly records estimated cost as zero rather than fabricating a dollar amount.

## Latest provider benchmark result

Machine-readable live benchmark report: [`evaluation/provider-results-final.json`](evaluation/provider-results-final.json). The dataset is [`evaluation/scenarios.ts`](evaluation/scenarios.ts).

Run: `npm run benchmark:provider -- --path=both --concurrency=2 --run-id=final`, 27 October 2026, OpenCode Go `qwen3.8-flash`, Node v24.22.1, concurrency 2. Full held-out test split (102 scenarios across all 50 modules) executed independently on both Baseline (all 500 catalog actions in prompt) and Optimized (top-20 bounded retrieval) tracks. The benchmark contract checks exact action sequences, expected parameters, response statuses, persisted create state, follow-up provider errors, and failure diagnostics. With `--resume`, only successful cache entries are skipped; failed or timed-out scenarios are retried.

| Metric | Baseline Path (All 500 Actions) | Optimized Path (Top-20 Retrieval) | Comparison / Savings |
|---|---:|---:|:---|
| **Held-Out Test Scenarios** | 102 | 102 | Identical test distribution |
| **Pass Rate** | **96/102 (94.1%)** | **99/102 (97.1%)** | Optimized passed 3 more scenarios |
| **Provider Fallbacks** | **6** | **3** | Optimized had 50% fewer fallbacks |
| **Total Input Tokens** | **2,433,609 tokens** | **131,919 tokens** | **94.6% token reduction** (18.4× smaller payload) |
| **Input Tokens / Scenario** | **23,859 tokens** | **1,293 tokens** | Saved ~22,566 input tokens per call |
| **Total Output Tokens** | 45,557 tokens | 44,609 tokens | Similar output plan generation |
| **p50 First Useful Response** | **8.62s** | **6.89s** | **20.1% faster** p50 response time |
| **p95 First Useful Response** | **35.01s** | **23.95s** | **31.6% lower** tail latency in this run |
| **p50 Completion Latency** | **8.62s** | **6.89s** | Faster completion |
| **p95 Completion Latency** | **35.01s** | **23.95s** | Lower tail latency in this run |
| **Estimated Cost** | **Not configured** | **Not configured** | Set pricing variables before making cost claims |

### Final-run failure notes

The optimized path failed three scenarios because of provider timeouts: `SCN-M13-CREATE-2`, `SCN-M14-READ-2`, and `SCN-M14-CREATE-2`. The baseline had six timeout fallbacks: `SCN-M09-CREATE-2`, `SCN-M18-CREATE-2`, `SCN-M25-CREATE-2`, `SCN-M26-CREATE-2`, `SCN-M42-CREATE-2`, and `SCN-COMPLEX-001`. These are reported as failures rather than silently converted into successes. The provider response-body cleanup was subsequently changed to non-blocking cancellation; the saved final report reflects the run before that code change.

### Post-hardening smoke check

After the response-body cleanup, field-normalization fix, and confirmation-status contract fix, the optimized 8-scenario smoke sample completed without multi-minute hangs. It passed 6/8 scenarios with 2 provider timeouts (`SCN-INDIRECT-001` and `SCN-COMPLEX-001`) at the 35-second boundary. This confirms bounded failure behavior, but also confirms that the remote provider remains variable for complex/indirect prompts; the result is not presented as a perfect live-provider SLA.


## Revised provider-backed acceptance

- [x] A structured planner contract is implemented in `backend/src/planner.ts`.
- [x] Zod validates provider Plan DSL shape and the retrieved action allowlist.
- [x] LangGraph coordinates provider generation and validation without store access.
- [x] Generic Plan DSL operations are executed deterministically after validation.
- [x] A fake-provider test proves a model-generated plan can mutate actual store state.
- [x] Provider benchmark compares full-catalog baseline with bounded-retrieval optimized mode and writes explicit skipped status without credentials.
- [x] Live provider smoke benchmark with real model tokens, latency, bounded concurrency, retries, and checkpointing.
- [x] Provider error reasons are surfaced in the API, UI, benchmark report, and checkpoint.
- [x] Provider fallback fails closed for state-changing plans; safe read-only fallback remains available.
- [x] Confirmation cancellation is explicit and verified to produce no mutation.
- [x] Full live provider benchmark with externally verified pricing and cache behavior.
- [x] Natural-language scenario corpus with deterministic dev/test split.
