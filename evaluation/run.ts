import { writeFile } from "node:fs/promises";
import { ActionRegistry } from "../backend/src/registry.js";
import { AskAIEngine } from "../backend/src/engine.js";
import { MockStore } from "../backend/src/store.js";
import { MODULES } from "../backend/src/catalog.js";
import { buildScenarios } from "./scenarios.js";

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

async function runPath(optimized: boolean): Promise<Record<string, unknown>> {
  const registry = new ActionRegistry();
  const store = new MockStore(MODULES.map((module) => module.id));
  const engine = new AskAIEngine(store, registry, optimized ? "optimized" : "baseline");
  const scenarios = buildScenarios();
  const durations: number[] = [];
  const firstUseful: number[] = [];
  const directDurations: number[] = [];
  const directFirstUseful: number[] = [];
  const complexDurations: number[] = [];
  const complexFirstUseful: number[] = [];
  let passed = 0;
  let selected = 0;
  let parameterMatches = 0;
  let parameterChecks = 0;
  let finalStateMatches = 0;
  let finalStateChecks = 0;
  const failedScenarioIds: string[] = [];
  for (const scenario of scenarios) {
    engine.reset();
    const started = performance.now();
    let response = await engine.chat({ sessionId: scenario.id, message: scenario.messages[0] ?? "" });
    if (response.status === "needs_confirmation" && response.confirmationToken) response = await engine.chat({ sessionId: scenario.id, message: "Confirm", confirmationToken: response.confirmationToken, planHash: response.confirmation?.planHash });
    const traces = [...response.trace];
    let followSatisfied = true;
    for (const follow of scenario.messages.slice(1)) {
      const followResponse = await engine.chat({ sessionId: scenario.id, message: follow });
      traces.push(...followResponse.trace);
      followSatisfied = followSatisfied && followResponse.status === "completed";
    }
    for (const expected of scenario.expectedActionIds) if (traces.some((step) => step.actionId === expected)) selected += 1;
    for (const expected of scenario.expectedActionIds) {
      const matched = traces.find((step) => step.actionId === expected && step.status === "success");
      if (matched) {
        parameterChecks += 1;
        const expectedFields = scenario.expectedParameters?.[expected] ?? [];
        const hasFields = expectedFields.every((field) => {
          const value = field === "name" ? matched.input.name ?? (matched.input.fields && typeof matched.input.fields === "object" ? (matched.input.fields as Record<string, unknown>).name : undefined) : matched.input[field];
          return value !== undefined && value !== null && value !== "";
        });
        if (hasFields) parameterMatches += 1;
      }
    }
    const expectedSatisfied = scenario.expectedActionIds.length === 0 || scenario.expectedActionIds.every((expected) => traces.some((step) => step.actionId === expected));
    for (const step of traces) {
      const definition = registry.get(step.actionId);
      if (!definition || step.status !== "success" || !["create", "update", "archive", "delete", "relationship", "transition", "message", "financial", "schedule"].includes(definition.operation)) continue;
      const output = step.output && typeof step.output === "object" && !Array.isArray(step.output) ? step.output as { id?: string } : undefined;
      if (!output?.id) continue;
      finalStateChecks += 1;
      const visible = store.get(definition.moduleId, output.id);
      if ((definition.operation === "archive" || definition.operation === "delete") ? !visible : Boolean(visible)) finalStateMatches += 1;
    }
    if (expectedSatisfied && followSatisfied) passed += 1;
    else failedScenarioIds.push(scenario.id);
    const completionMs = performance.now() - started;
    const usefulMs = response.metrics.firstUsefulResponseMs;
    durations.push(completionMs);
    firstUseful.push(usefulMs);
    if (scenario.category === "multi_step") {
      complexDurations.push(completionMs);
      complexFirstUseful.push(usefulMs);
    } else {
      directDurations.push(completionMs);
      directFirstUseful.push(usefulMs);
    }
  }
  return { path: optimized ? "optimized" : "baseline", scenarios: scenarios.length, passed, failedScenarioIds, endToEndSuccessRate: passed / scenarios.length, actionSelectionAccuracy: selected / Math.max(1, scenarios.flatMap((scenario) => scenario.expectedActionIds).length), parameterAccuracy: parameterMatches / Math.max(1, parameterChecks), finalStateChecks, finalStateMatches, finalStateCorrectness: finalStateMatches / Math.max(1, finalStateChecks), p50TimeToFirstUsefulResponseMs: percentile(firstUseful, 0.5), p95TimeToFirstUsefulResponseMs: percentile(firstUseful, 0.95), p50CompletionMs: percentile(durations, 0.5), p95CompletionMs: percentile(durations, 0.95), direct: { p50TimeToFirstUsefulResponseMs: percentile(directFirstUseful, 0.5), p95TimeToFirstUsefulResponseMs: percentile(directFirstUseful, 0.95), p50CompletionMs: percentile(directDurations, 0.5), p95CompletionMs: percentile(directDurations, 0.95) }, complex: { p50TimeToFirstUsefulResponseMs: percentile(complexFirstUseful, 0.5), p95TimeToFirstUsefulResponseMs: percentile(complexFirstUseful, 0.95), p50CompletionMs: percentile(complexDurations, 0.5), p95CompletionMs: percentile(complexDurations, 0.95) }, modelCalls: 0, retries: 0, estimatedCostUsd: 0, providerLatency: "NOT_MEASURED", providerTokens: "NOT_MEASURED" };
}

const baseline = await runPath(false);
const optimized = await runPath(true);
const report = { generatedAt: new Date().toISOString(), environment: { node: process.version, provider: "deterministic local engine", pricing: "NOT_MEASURED" }, targets: { p95DirectMs: 100, p95ComplexMs: 250, actionSelection: 0.9, finalState: 0.9 }, baseline, optimized, limitations: ["No external provider is configured; provider latency/tokens/cost are NOT_MEASURED.", "Synthetic store is process-local."] };
await writeFile("evaluation/results.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
