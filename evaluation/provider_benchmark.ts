import { readFile, rename, writeFile } from "node:fs/promises";
import { ActionRegistry } from "../backend/src/registry.js";
import { AskAIEngine } from "../backend/src/engine.js";
import { MockStore } from "../backend/src/store.js";
import { MODULES } from "../backend/src/catalog.js";
import { providerFromEnvironment } from "../backend/src/provider.js";
import { buildScenarios, type EvaluationScenario } from "./scenarios.js";

const DEFAULT_CACHE_PATH = "evaluation/.benchmark_cache.json";
const DEFAULT_REPORT_PATH = "evaluation/provider-results.json";
const BENCHMARK_CONTRACT_VERSION = 3;

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
};

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const prefix = `${flag}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};

const quickMode = args.includes("--quick") || args.includes("-q");
const resumeMode = args.includes("--resume");
const runId = getArg("--run-id")?.replace(/[^a-zA-Z0-9_-]/g, "-");
const cachePath = runId ? `evaluation/.benchmark_cache-${runId}.json` : DEFAULT_CACHE_PATH;
const reportPath = runId ? `evaluation/provider-results-${runId}.json` : DEFAULT_REPORT_PATH;
const limitCount = quickMode ? 8 : Number(getArg("--limit") ?? getArg("-l") ?? 0);
const targetPath = (getArg("--path") ?? getArg("-p") ?? "both").toLowerCase();
const concurrency = Math.max(1, Math.min(3, Number(getArg("--concurrency") ?? getArg("-c") ?? 1)));

function selectScenarios(): EvaluationScenario[] {
  const allScenarios = buildScenarios("all");
  if (quickMode) {
    const categories: EvaluationScenario["category"][] = [
      "direct", "indirect", "multi_step", "follow_up", "ambiguous", "unsupported", "confirmation", "invalid"
    ];
    const picked: EvaluationScenario[] = [];
    for (const category of categories) {
      const match = allScenarios.find((scenario) => scenario.category === category && !picked.some((selected) => selected.id === scenario.id));
      if (match) picked.push(match);
    }
    return picked;
  }
  const testScenarios = buildScenarios("test");
  return limitCount > 0 ? testScenarios.slice(0, limitCount) : testScenarios;
}

interface ScenarioResult {
  scenarioId: string;
  category: EvaluationScenario["category"];
  passed: boolean;
  providerFallbacks: number;
  completionMs: number;
  firstUsefulResponseMs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  providerErrors: string[];
  actualActionIds: string[];
  statusSequence: string[];
  parameterAccuracy: boolean;
  finalStateCorrect: boolean;
  failureReasons: string[];
}

interface BenchmarkCache {
  version: number;
  signature: string;
  generatedAt: string;
  entries: Record<string, ScenarioResult>;
}

interface VariantResult {
  path: "baseline" | "optimized";
  scenarios: number;
  completedFromCache: number;
  passed: number;
  failedScenarioIds: string[];
  providerFallbacks: number;
  endToEndSuccessRate: number;
  p50TimeToFirstUsefulResponseMs: number;
  p95TimeToFirstUsefulResponseMs: number;
  p50CompletionMs: number;
  p95CompletionMs: number;
  directP95CompletionMs: number;
  complexP95CompletionMs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  providerErrors: Array<{ scenarioId: string; message: string }>;
}

const cacheKey = (path: "baseline" | "optimized", scenarioId: string): string => `${path}:${scenarioId}`;

const newCache = (signature: string): BenchmarkCache => ({
  version: BENCHMARK_CONTRACT_VERSION,
  signature,
  generatedAt: new Date().toISOString(),
  entries: {}
});

async function loadCache(signature: string): Promise<BenchmarkCache> {
  if (!resumeMode) return newCache(signature);
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<BenchmarkCache>;
    if (parsed.version !== BENCHMARK_CONTRACT_VERSION || parsed.signature !== signature || !parsed.entries || typeof parsed.entries !== "object") return newCache(signature);
    const entries = Object.fromEntries(Object.entries(parsed.entries as Record<string, Partial<ScenarioResult>>).map(([key, result]) => [key, {
      ...result,
      providerErrors: Array.isArray(result.providerErrors) ? result.providerErrors : []
    }])) as Record<string, ScenarioResult>;
    return { version: BENCHMARK_CONTRACT_VERSION, signature, generatedAt: parsed.generatedAt ?? new Date().toISOString(), entries };
  } catch {
    return newCache(signature);
  }
}

let checkpointQueue = Promise.resolve();
function saveCheckpoint(cache: BenchmarkCache): Promise<void> {
  checkpointQueue = checkpointQueue.then(async () => {
    cache.generatedAt = new Date().toISOString();
    const temporaryPath = `${cachePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(cache, null, 2));
    await rename(temporaryPath, cachePath);
  });
  return checkpointQueue;
}

async function executeScenario(
  path: "baseline" | "optimized",
  scenario: EvaluationScenario,
  provider: NonNullable<ReturnType<typeof providerFromEnvironment>>
): Promise<ScenarioResult> {
  // Each scenario owns its engine and store. This makes bounded concurrency safe
  // and prevents one scenario's reset from corrupting another scenario's state.
  const registry = new ActionRegistry();
  const store = new MockStore(MODULES.map((module) => module.id));
  const engine = new AskAIEngine(store, registry, path, provider);
  const sessionId = `ask-ai-benchmark-${path}-${scenario.id}-${Date.now()}`;
  const started = performance.now();
  let response = await engine.chat({ sessionId, message: scenario.messages[0] ?? "" });
  const initialResponse = response;
  const allResponses = [initialResponse];
  if (response.status === "needs_confirmation" && response.confirmationToken) {
    response = await engine.chat({
      sessionId,
      message: "Confirm",
      confirmationToken: response.confirmationToken,
      planHash: response.confirmation?.planHash
    });
    allResponses.push(response);
  }

  const traces = [...response.trace];
  let followSatisfied = true;
  let providerFallbacks = allResponses.filter((item) => item.executionMode === "provider_fallback").length;
  let modelCalls = allResponses.reduce((total, item) => total + item.metrics.modelCalls, 0);
  let inputTokens = allResponses.reduce((total, item) => total + item.metrics.inputTokens, 0);
  let outputTokens = allResponses.reduce((total, item) => total + item.metrics.outputTokens, 0);
  let estimatedCostUsd = allResponses.reduce((total, item) => total + item.metrics.estimatedCostUsd, 0);
  const providerErrors = allResponses.flatMap((item) => item.providerError?.message ? [item.providerError.message] : []);
  for (const follow of scenario.messages.slice(1)) {
    const followResponse = await engine.chat({ sessionId, message: follow });
    allResponses.push(followResponse);
    traces.push(...followResponse.trace);
    followSatisfied = followSatisfied && followResponse.status === "completed";
    providerFallbacks += followResponse.executionMode === "provider_fallback" ? 1 : 0;
    modelCalls += followResponse.metrics.modelCalls;
    inputTokens += followResponse.metrics.inputTokens;
    outputTokens += followResponse.metrics.outputTokens;
    estimatedCostUsd += followResponse.metrics.estimatedCostUsd;
    if (followResponse.providerError?.message) providerErrors.push(followResponse.providerError.message);
  }

  const actualActionIds = traces.filter((step) => step.actionId.startsWith("M") && step.status !== "skipped").map((step) => step.actionId);
  const expectedSequence = scenario.expectedActionSequence ?? scenario.expectedActionIds;
  const sequenceSatisfied = JSON.stringify(actualActionIds) === JSON.stringify(expectedSequence);
  const expectedSatisfied = scenario.expectedActionIds.every((expected) => actualActionIds.includes(expected)) || scenario.expectedActionIds.length === 0;
  const statusSequence = allResponses.map((item) => item.status);
  const acceptedStatusSequences = scenario.acceptableStatusSequences ?? (scenario.expectedStatuses ? [scenario.expectedStatuses] : []);
  const statusSatisfied = acceptedStatusSequences.length === 0 || acceptedStatusSequences.some((expected) => JSON.stringify(statusSequence) === JSON.stringify(expected));
  const parameterAccuracy = Object.entries(scenario.expectedParameters ?? {}).every(([actionId, fields]) => traces.some((step) => {
    if (step.actionId !== actionId) return false;
    const input = step.input as Record<string, unknown>;
    const nested = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields) ? input.fields as Record<string, unknown> : {};
    return fields.every((field) => input[field] !== undefined || nested[field] !== undefined);
  }));
  const finalStateCorrect = traces.filter((step) => step.status === "success" && step.actionId.startsWith("M"))
    .filter((step) => registry.get(step.actionId)?.operation === "create")
    .every((step) => {
      const outputs = Array.isArray(step.output) ? step.output : [step.output];
      return outputs.every((output) => {
        if (!output || typeof output !== "object" || Array.isArray(output) || typeof (output as { id?: unknown }).id !== "string") return false;
        const action = registry.get(step.actionId);
        return Boolean(action && store.get(action.moduleId, (output as { id: string }).id));
      });
    });
  const failureReasons: string[] = [];
  if (!sequenceSatisfied) failureReasons.push(`action sequence expected ${expectedSequence.join(",")} but got ${actualActionIds.join(",")}`);
  if (!expectedSatisfied) failureReasons.push("missing expected action");
  if (!parameterAccuracy) failureReasons.push("expected parameters were not present");
  if (!finalStateCorrect) failureReasons.push("created output was not readable from final store state");
  if (!statusSatisfied) failureReasons.push(`status sequence expected ${scenario.expectedStatuses?.join(",")} but got ${statusSequence.join(",")}`);
  if (!followSatisfied) failureReasons.push("follow-up did not complete");
  if (providerFallbacks > 0) failureReasons.push("provider fallback occurred");
  if (providerErrors.length) failureReasons.push(...providerErrors.map((error) => `provider error: ${error}`));
  const passed = sequenceSatisfied && expectedSatisfied && parameterAccuracy && finalStateCorrect && statusSatisfied && followSatisfied && providerFallbacks === 0 && providerErrors.length === 0;
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    passed,
    providerFallbacks,
    completionMs: performance.now() - started,
    firstUsefulResponseMs: initialResponse.metrics.firstUsefulResponseMs,
    modelCalls,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    providerErrors,
    actualActionIds,
    statusSequence,
    parameterAccuracy,
    finalStateCorrect,
    failureReasons
  };
}

function aggregateVariant(path: "baseline" | "optimized", scenarios: EvaluationScenario[], results: ScenarioResult[], completedFromCache: number): VariantResult {
  const durations = results.map((result) => result.completionMs);
  const firstUseful = results.map((result) => result.firstUsefulResponseMs);
  const direct = results.filter((result) => result.category !== "multi_step").map((result) => result.completionMs);
  const complex = results.filter((result) => result.category === "multi_step").map((result) => result.completionMs);
  const passed = results.filter((result) => result.passed).length;
  const modelCalls = results.reduce((total, result) => total + result.modelCalls, 0);
  const inputTokens = results.reduce((total, result) => total + result.inputTokens, 0);
  const outputTokens = results.reduce((total, result) => total + result.outputTokens, 0);
  const estimatedCostUsd = results.reduce((total, result) => total + result.estimatedCostUsd, 0);
  const providerFallbacks = results.reduce((total, result) => total + result.providerFallbacks, 0);
  const providerErrors = results.flatMap((result) => result.providerErrors.map((message) => ({ scenarioId: result.scenarioId, message })));
  return {
    path,
    scenarios: scenarios.length,
    completedFromCache,
    passed,
    failedScenarioIds: results.filter((result) => !result.passed).map((result) => result.scenarioId),
    providerFallbacks,
    endToEndSuccessRate: passed / Math.max(1, scenarios.length),
    p50TimeToFirstUsefulResponseMs: percentile(firstUseful, 0.5),
    p95TimeToFirstUsefulResponseMs: percentile(firstUseful, 0.95),
    p50CompletionMs: percentile(durations, 0.5),
    p95CompletionMs: percentile(durations, 0.95),
    directP95CompletionMs: percentile(direct, 0.95),
    complexP95CompletionMs: percentile(complex, 0.95),
    modelCalls,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    providerErrors
  };
}

async function runVariant(
  path: "baseline" | "optimized",
  scenarios: EvaluationScenario[],
  provider: NonNullable<ReturnType<typeof providerFromEnvironment>>,
  cache: BenchmarkCache
): Promise<VariantResult> {
  console.log(`\n======================================================`);
  console.log(`▶ Starting ${path.toUpperCase()} benchmark (${scenarios.length} scenarios, concurrency=${concurrency})`);
  console.log(`  Path description: ${path === "baseline" ? "All 500 actions in prompt (Naive)" : "Top-20 Hybrid Retrieval (Optimized)"}`);
  console.log(`======================================================\n`);

  const cachedResults = resumeMode
    ? scenarios.map((scenario) => cache.entries[cacheKey(path, scenario.id)]).filter((result): result is ScenarioResult => Boolean(result?.passed))
    : [];
  const cachedIds = new Set(cachedResults.map((result) => result.scenarioId));
  const pending = scenarios.filter((scenario) => !cachedIds.has(scenario.id));
  if (cachedResults.length) console.log(`Resuming ${path}: ${cachedResults.length} completed scenario(s) loaded from ${cachePath}.`);
  const failedCachedCount = resumeMode
    ? scenarios.filter((scenario) => {
      const result = cache.entries[cacheKey(path, scenario.id)];
      return Boolean(result && !result.passed);
    }).length
    : 0;
  if (failedCachedCount) console.log(`Retrying ${path}: ${failedCachedCount} previously failed scenario(s).`);

  let nextIndex = 0;
  const freshResults: ScenarioResult[] = [];
  const worker = async (workerId: number): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      const scenario = pending[index];
      if (!scenario) return;
      const prefix = `[${path.slice(0, 4)}] [${String(index + 1).padStart(String(pending.length).length, " ")}/${pending.length}] ${scenario.id.padEnd(20)} (${scenario.category.padEnd(12)})`;
      process.stdout.write(`${prefix} worker-${workerId} ... `);
      try {
        const result = await executeScenario(path, scenario, provider);
        freshResults.push(result);
        cache.entries[cacheKey(path, scenario.id)] = result;
        await saveCheckpoint(cache);
        const mark = result.passed ? "\x1b[32m✓ PASS\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m";
        const modeTag = result.providerFallbacks ? ` [${result.providerFallbacks} FALLBACK]` : " [provider]";
        console.log(`${mark} (${(result.completionMs / 1000).toFixed(1)}s, in:${(result.inputTokens / 1000).toFixed(1)}k)${modeTag}`);
      } catch (error) {
        const result: ScenarioResult = {
          scenarioId: scenario.id,
          category: scenario.category,
          passed: false,
          providerFallbacks: 1,
          completionMs: 0,
          firstUsefulResponseMs: 0,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          providerErrors: [error instanceof Error ? error.message : String(error)],
          actualActionIds: [],
          statusSequence: [],
          parameterAccuracy: false,
          finalStateCorrect: false,
          failureReasons: [error instanceof Error ? error.message : String(error)]
        };
        freshResults.push(result);
        cache.entries[cacheKey(path, scenario.id)] = result;
        await saveCheckpoint(cache);
        console.log(`\x1b[31m✗ ERROR\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, (_, index) => worker(index + 1)));
  const results = [...cachedResults, ...freshResults];
  const result = aggregateVariant(path, scenarios, results, cachedResults.length);
  console.log(`\n--- ${path.toUpperCase()} Summary ---`);
  console.log(`Passed: ${result.passed}/${result.scenarios} (${(result.endToEndSuccessRate * 100).toFixed(1)}%) | Fallbacks: ${result.providerFallbacks}`);
  console.log(`p50 Latency: ${(result.p50CompletionMs / 1000).toFixed(2)}s | p95: ${(result.p95CompletionMs / 1000).toFixed(2)}s`);
  console.log(`Total Tokens: ${(result.inputTokens / 1000).toFixed(1)}k in, ${(result.outputTokens / 1000).toFixed(1)}k out | Est Cost: $${result.estimatedCostUsd.toFixed(4)}\n`);
  return result;
}

async function main() {
  const provider = providerFromEnvironment();
  const scenarios = selectScenarios();

  console.log(`\n================================================================`);
  console.log(`       HIGHLEVEL ASK AI — LIVE PROVIDER BENCHMARK RUNNER        `);
  console.log(`================================================================`);
  console.log(`Provider:        ${provider ? provider.name : "\x1b[31mNOT CONFIGURED\x1b[0m"}`);
  console.log(`Model:           ${process.env.ASK_AI_MODEL ?? "gpt-4o-mini"}`);
  console.log(`Scenarios:       ${scenarios.length} ${quickMode ? "(Quick Diversity Sample)" : limitCount > 0 ? `(Limited to ${limitCount})` : "(Full Test Split)"}`);
  console.log(`Target Path:     ${targetPath.toUpperCase()}`);
  console.log(`Concurrency:     ${concurrency}`);
  console.log(`Resume:          ${resumeMode ? "enabled" : "disabled"}`);
  console.log(`================================================================`);

  if (!provider) {
    const report = {
      status: "skipped",
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, provider: "NOT_CONFIGURED", scenarios: scenarios.length },
      reason: "Set ASK_AI_LLM_API_KEY or OPENAI_API_KEY in .env to run the live provider benchmark.",
      baseline: "NOT_MEASURED",
      optimized: "NOT_MEASURED"
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log("\nProvider credentials not found. Benchmark skipped. Set ASK_AI_LLM_API_KEY in .env to enable.");
    return;
  }

  const signature = [`contract-${BENCHMARK_CONTRACT_VERSION}`, provider.name, process.env.ASK_AI_MODEL ?? "gpt-4o-mini", process.env.ASK_AI_LLM_ENDPOINT ?? "default"].join("|");
  const cache = await loadCache(signature);
  if (!resumeMode) await saveCheckpoint(cache);

  const runBaseline = targetPath === "both" || targetPath === "baseline";
  const runOptimized = targetPath === "both" || targetPath === "optimized";
  const baselineResult = runBaseline ? await runVariant("baseline", scenarios, provider, cache) : "SKIPPED";
  const optimizedResult = runOptimized ? await runVariant("optimized", scenarios, provider, cache) : "SKIPPED";

  const report = {
    status: "completed",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      provider: provider.name,
      model: process.env.ASK_AI_MODEL ?? "gpt-4o-mini",
      pricing: {
        inputPer1M: Number(process.env.ASK_AI_INPUT_COST_PER_1M ?? 0),
        outputPer1M: Number(process.env.ASK_AI_OUTPUT_COST_PER_1M ?? 0)
      },
      scenarioCount: scenarios.length,
      mode: quickMode ? "quick_sample" : limitCount > 0 ? `limited_${limitCount}` : "full",
      concurrency,
      resumed: resumeMode,
      runId: runId ?? null
    },
    baseline: baselineResult,
    optimized: optimizedResult
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull JSON report written to ${reportPath}`);
  console.log(`Checkpoint retained at ${cachePath}; use --resume${runId ? ` --run-id=${runId}` : ""} to continue completed scenarios.\n`);
}

main().catch((error) => {
  console.error("Benchmark runner failed:", error);
  process.exit(1);
});
