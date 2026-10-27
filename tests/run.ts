import assert from "node:assert/strict";
import { ActionRegistry } from "../backend/src/registry.js";
import { AskAIEngine } from "../backend/src/engine.js";
import { MockStore } from "../backend/src/store.js";
import { MODULES } from "../backend/src/catalog.js";
import { buildScenarios } from "../evaluation/scenarios.js";
import type { JsonObject } from "../backend/src/types.js";
import type { LLMProvider } from "../backend/src/provider.js";
import { validatePlanDocument } from "../backend/src/plan.js";

const registry = new ActionRegistry();
const store = new MockStore(MODULES.map((module) => module.id));
const engine = new AskAIEngine(store, registry);

assert.equal(MODULES.length, 50, "must register exactly 50 modules");
assert.equal(registry.all().length, 500, "must register exactly 500 actions");
for (const module of MODULES) assert.equal(registry.all().filter((action) => action.moduleId === module.id).length, 10, `${module.id} must have ten actions`);

const beforeReset = JSON.stringify(MODULES.map((module) => store.list(module.id)));
store.reset();
assert.equal(JSON.stringify(MODULES.map((module) => store.list(module.id))), beforeReset, "reset must be reproducible");

const validInput = (actionId: string, operation: string): JsonObject => {
  const moduleId = actionId.slice(0, 3);
  if (operation === "create") return { name: `Smoke ${actionId}`, fields: { name: `Smoke ${actionId}` } };
  if (operation === "search" || operation === "report") return { query: "sample" };
  if (actionId === "M01.A09") return { id: "M01-0001", fields: { relatedContactId: "M01-0002" } };
  if (actionId === "M02.A06" || actionId === "M02.A07") return { id: "M02-0001", fields: { contactId: "M01-0002" } };
  if (actionId === "M29.A07") return { id: "M29-0001", fields: { invoiceId: "M28-0001", amount: 12.5 } };
  return { id: `${moduleId}-0001`, fields: { smoke: true, amount: 12.5 } };
};

let smokePassed = 0;
for (const action of registry.all()) {
  store.reset();
  const result = await registry.execute(action.id, validInput(action.id, action.operation), { store, traceId: "SMOKE", stepId: action.id });
  assert.ok(result.ok || result.error?.code === "NOT_FOUND", `${action.id} must return a meaningful result`);
  smokePassed += 1;
}
assert.equal(smokePassed, 500);

const providerShapedContact = await registry.execute("M01.A01", { name: "Provider Contact", fields: { email: "provider@example.com" } }, { store, traceId: "PROVIDER-SHAPE", stepId: "M01.A01" });
assert.equal(providerShapedContact.ok, true);
assert.equal((providerShapedContact.data as { name?: string }).name, "Provider Contact", "provider-shaped top-level names must be merged with nested fields");
const providerShapedTask = await registry.execute("M06.A01", { name: "Provider Task", fields: { description: "Provider-shaped payload" } }, { store, traceId: "PROVIDER-SHAPE", stepId: "M06.A01" });
assert.equal(providerShapedTask.ok, true);
assert.equal((providerShapedTask.data as { name?: string }).name, "Provider Task", "provider-shaped task names must be preserved");
store.reset();

const created = await engine.chat({ sessionId: "test-direct", message: "Create a contact named Priya Shah with priya@example.com" });
assert.equal(created.status, "completed");
assert.ok(created.trace.some((step) => step.actionId === "M01.A01" && step.status === "success"));
assert.match(created.message, /Priya Shah \(M01-\d{4}\)/, "create response should identify the persisted contact");
const createdId = created.trace.find((step) => step.actionId === "M01.A01")?.output as { id?: string };
assert.ok(createdId.id && store.get("M01", createdId.id), "created contact must be readable from state");
const missingAfterCreate = await engine.chat({ sessionId: "test-direct", message: "Create a contact" });
assert.equal(missingAfterCreate.status, "needs_clarification", "a missing contact name must clarify even with prior session context");

const searched = await engine.chat({ sessionId: "test-search", message: "Search contacts for Sarah" });
assert.equal(searched.status, "completed");
assert.equal((searched.trace[0]?.output as unknown[]).length, 1, "contact search should use the meaningful search term");

const followUp = await engine.chat({ sessionId: "test-follow", message: "Find leads who have gone quiet, skip anyone with booked appointments, and create follow-up tasks" });
assert.equal(followUp.status, "needs_confirmation");
assert.equal(followUp.confirmation?.estimatedMutationCount, 1);
const followUpConfirmed = await engine.chat({ sessionId: "test-follow", message: "Confirm", confirmationToken: followUp.confirmationToken, planHash: followUp.confirmation?.planHash });
assert.equal(followUpConfirmed.status, "completed");
assert.deepEqual(followUpConfirmed.trace.map((step) => step.actionId), ["M03.A03", "M21.A03", "M06.A01"]);
assert.equal(store.list("M06").filter((task) => task.sourceAction === "M06.A01").length, 1, "booked contacts must be excluded from task fan-out");
assert.equal(store.list("M06").find((task) => task.sourceAction === "M06.A01")?.contactId, "M01-0002", "eligible lead must receive the task");
const followUp2 = await engine.chat({ sessionId: "test-follow", message: "Make those tasks due tomorrow" });
assert.equal(followUp2.status, "completed");
assert.ok(followUp2.trace.every((step) => step.actionId === "M06.A06"));

const ambiguous = await engine.chat({ sessionId: "test-ambiguous", message: "Create a contact" });
assert.equal(ambiguous.status, "needs_clarification");
const unsupported = await engine.chat({ sessionId: "test-unsupported", message: "Book me a flight" });
assert.equal(unsupported.status, "unsupported");
const confirmation = await engine.chat({ sessionId: "test-confirm", message: "Archive contact M01-0001" });
assert.equal(confirmation.status, "needs_confirmation");
assert.ok(confirmation.confirmationToken);
assert.ok(confirmation.confirmation?.planHash, "confirmation must include a stable plan hash");
assert.equal(confirmation.confirmation?.targetRecords[0]?.id, "M01-0001");
assert.equal(confirmation.confirmation?.targetRecords[0]?.name, "Sarah Chen");
assert.equal(confirmation.confirmation?.targetRecords[0]?.email, "sarah@example.com");
const rejectedWithoutHash = await engine.chat({ sessionId: "test-confirm", message: "Confirm", confirmationToken: confirmation.confirmationToken });
assert.equal(rejectedWithoutHash.status, "needs_confirmation", "confirmation without the plan hash must not execute");
const confirmed = await engine.chat({ sessionId: "test-confirm", message: "Confirm", confirmationToken: confirmation.confirmationToken, planHash: confirmation.confirmation?.planHash });
assert.equal(confirmed.status, "completed");
assert.equal(store.get("M01", "M01-0001"), undefined, "archived contact must not appear in active reads");
const cancelStore = new MockStore(MODULES.map((module) => module.id));
const cancelEngine = new AskAIEngine(cancelStore, new ActionRegistry(), "optimized");
const cancellable = await cancelEngine.chat({ sessionId: "test-cancel", message: "Archive contact M01-0001" });
assert.equal(cancellable.status, "needs_confirmation");
const cancelled = await cancelEngine.chat({ sessionId: "test-cancel", message: "Cancel", confirmationToken: cancellable.confirmationToken, planHash: cancellable.confirmation?.planHash, cancelConfirmation: true });
assert.equal(cancelled.status, "cancelled");
assert.ok(cancelStore.get("M01", "M01-0001"), "cancelled confirmation must not mutate state");

store.reset();
store.failNext("M03.A03");
const retried = await engine.chat({ sessionId: "test-retry", message: "Search leads" });
assert.equal(retried.status, "completed");
assert.equal(retried.metrics.retries, 1, "safe reads must retry once after a transient tool failure");

store.reset();
store.failNext("M03.A03");
store.failNext("M03.A03");
const partial = await engine.chat({ sessionId: "test-partial", message: "Find leads who have gone quiet, skip anyone with booked appointments, and create follow-up tasks" });
assert.equal(partial.status, "needs_confirmation");
store.failNext("M03.A03", 2);
const partialConfirmed = await engine.chat({ sessionId: "test-partial", message: "Confirm", confirmationToken: partial.confirmationToken, planHash: partial.confirmation?.planHash });
assert.equal(partialConfirmed.status, "partial");
assert.ok(partialConfirmed.trace.some((step) => step.status === "skipped"), "dependent steps must be skipped after a failed dependency");

store.reset();
const invoiceWorkflow = await engine.chat({ sessionId: "test-invoice", message: "Find overdue invoices, exclude customers reminded this week, and draft email reminders" });
assert.equal(invoiceWorkflow.status, "needs_confirmation");
const invoiceConfirmed = await engine.chat({ sessionId: "test-invoice", message: "Confirm", confirmationToken: invoiceWorkflow.confirmationToken, planHash: invoiceWorkflow.confirmation?.planHash });
assert.equal(invoiceConfirmed.status, "completed");
const draftedReminders = store.list("M13").filter((email) => email.sourceAction === "M13.A01");
assert.equal(draftedReminders.length, 1, "recently reminded customers must be excluded from invoice reminders");
assert.equal(draftedReminders[0]?.customerId, "M02-0002", "the unreminded overdue customer must receive the draft");

store.reset();
const missingMutationTarget = await registry.execute("M01.A05", {}, { store, traceId: "VALIDATION", stepId: "M01.A05" });
assert.equal(missingMutationTarget.ok, false);
assert.equal(missingMutationTarget.error?.code, "MISSING_ID", "mutations must reject missing target ids");
assert.ok(store.get("M01", "M01-0001"), "missing mutation target must not mutate the first record");

const beforeIdempotency = store.list("M01").length;
const firstIdempotent = await engine.chat({ sessionId: "test-idempotency", message: "Create a contact named Idempotent User", idempotencyKey: "create-1" });
const secondIdempotent = await engine.chat({ sessionId: "test-idempotency", message: "Create a contact named Idempotent User", idempotencyKey: "create-1" });
assert.equal(firstIdempotent.trace[0]?.output && JSON.stringify(firstIdempotent.trace[0].output), secondIdempotent.trace[0]?.output && JSON.stringify(secondIdempotent.trace[0].output));
assert.equal(store.list("M01").length, beforeIdempotency + 1, "replayed idempotency key must not duplicate a mutation");

const linked = await registry.execute("M02.A06", { id: "M02-0001", fields: { contactId: "M01-0002" } }, { store, traceId: "REL", stepId: "REL-1" });
assert.equal(linked.ok, true);
assert.ok(Array.isArray(store.get("M02", "M02-0001")?.contactIds) && (store.get("M02", "M02-0001")?.contactIds as string[]).includes("M01-0002"), "company relationship must persist");
assert.equal(store.get("M01", "M01-0002")?.companyId, "M02-0001", "reverse contact relationship must persist");

const typo = await engine.chat({ sessionId: "test-typo", message: "Creat a contcat named Typo Fixed" });
assert.equal(typo.status, "completed");
assert.ok(typo.trace.some((step) => step.actionId === "M01.A01"));

const providerStore = new MockStore(MODULES.map((module) => module.id));
const providerRegistry = new ActionRegistry();
const fakeProvider: LLMProvider = {
  name: "fake-structured-planner",
  async rankActions() {
    return { actionIds: ["M01.A01"], usage: { modelCalls: 1, inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0 } };
  },
  async generatePlan({ candidates }) {
    assert.ok(candidates.some((action) => action.id === "M01.A01"), "planner must receive the retrieved create-contact candidate");
    return {
      plan: {
        intent: "Create a contact",
        assumptions: [],
        clarification: null,
        unsupported: false,
        steps: [{ id: "s1", action: "M01.A01", args: { name: "LLM Planned", fields: { name: "LLM Planned", email: "llm@example.com" } }, dependsOn: [], purpose: "Create the requested contact." }]
      },
      usage: { modelCalls: 1, inputTokens: 40, outputTokens: 20, estimatedCostUsd: 0.001 }
    };
  }
};
const providerEngine = new AskAIEngine(providerStore, providerRegistry, "optimized", fakeProvider);
const providerResponse = await providerEngine.chat({ sessionId: "test-provider", message: "Create a contact named LLM Planned" });
assert.equal(providerResponse.status, "completed");
assert.equal(providerResponse.metrics.modelCalls, 1, "provider-backed planning must record a model call");
assert.equal(providerResponse.trace[0]?.actionId, "M01.A01");
assert.ok(providerStore.list("M01").some((record) => record.name === "LLM Planned"), "provider-generated plan must mutate actual state");

const repairStore = new MockStore(MODULES.map((module) => module.id));
const repairProvider: LLMProvider = {
  name: "fake-neighbouring-action-planner",
  async rankActions() { return { actionIds: ["M25.A01", "M26.A01"], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; },
  async generatePlan({ candidates }) {
    assert.ok(candidates.some((action) => action.id === "M26.A01"), "optimized retrieval must retain the exact product-price action");
    return {
      plan: {
        intent: "Create a product price",
        assumptions: [],
        clarification: null,
        unsupported: false,
        // Deliberately choose the neighbouring Create product action. The
        // direct-intent guardrail must repair this to M26.A01.
        steps: [{ id: "s1", action: "M25.A01", args: { name: "Prices Pilot M26", fields: { name: "Prices Pilot M26" } }, dependsOn: [], purpose: "Create the requested record." }]
      },
      usage: { modelCalls: 1, inputTokens: 40, outputTokens: 20, estimatedCostUsd: 0 }
    };
  }
};
const repairEngine = new AskAIEngine(repairStore, new ActionRegistry(), "optimized", repairProvider);
const repairedResponse = await repairEngine.chat({ sessionId: "test-neighbouring-action", message: "We need to create product price named Prices Pilot M26 for the prices launch" });
assert.equal(repairedResponse.status, "completed");
assert.equal(repairedResponse.trace[0]?.actionId, "M26.A01", "direct intent guardrail must select the exact retrieved action");
assert.ok(repairStore.list("M26").some((record) => record.name === "Prices Pilot M26"), "repaired provider plan must persist in the intended module");

const readRepairStore = new MockStore(MODULES.map((module) => module.id));
const readRepairProvider: LLMProvider = {
  name: "fake-neighbouring-read-planner",
  async rankActions() { return { actionIds: ["M16.A02", "M16.A10"], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; },
  async generatePlan() {
    return {
      plan: {
        intent: "Get workflow definition",
        assumptions: [],
        clarification: null,
        unsupported: false,
        // The exact phrase is "get workflow definition"; this deliberately
        // selects the longer neighbouring read action.
        steps: [{ id: "s1", action: "M16.A10", args: { id: "M16-0001" }, dependsOn: [], purpose: "Read the workflow." }]
      },
      usage: { modelCalls: 1, inputTokens: 40, outputTokens: 20, estimatedCostUsd: 0 }
    };
  }
};
const readRepairEngine = new AskAIEngine(readRepairStore, new ActionRegistry(), "optimized", readRepairProvider);
const readRepairedResponse = await readRepairEngine.chat({ sessionId: "test-neighbouring-read", message: "I need you to get workflow definition for the workflows workspace, record M16-0001" });
assert.equal(readRepairedResponse.status, "completed");
assert.equal(readRepairedResponse.trace[0]?.actionId, "M16.A02", "exact direct-read phrase must outrank a longer prefix match");

const unavailableProvider: LLMProvider = {
  name: "unavailable-provider",
  async rankActions() { throw new Error("LLM provider returned HTTP 503"); },
  async generatePlan() { throw new Error("LLM provider returned HTTP 503"); }
};
const unavailableStore = new MockStore(MODULES.map((module) => module.id));
const unavailableEngine = new AskAIEngine(unavailableStore, new ActionRegistry(), "optimized", unavailableProvider);
const unavailableMutation = await unavailableEngine.chat({ sessionId: "test-provider-down", message: "Create a contact named No Silent Mutation" });
assert.equal(unavailableMutation.status, "provider_unavailable", "provider failure must fail closed for mutations");
assert.equal(unavailableStore.list("M01").some((record) => record.name === "No Silent Mutation"), false, "provider failure must not silently mutate state");
assert.match(unavailableMutation.providerError?.message ?? "", /503/);

const operationProvider: LLMProvider = {
  name: "fake-operation-planner",
  async rankActions() { return { actionIds: ["M01.A03"], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; },
  async generatePlan() {
    return {
      plan: {
        intent: "Count contacts",
        assumptions: [],
        clarification: null,
        unsupported: false,
        steps: [
          { id: "search", action: "M01.A03", args: { query: "Sarah" }, dependsOn: [], purpose: "Find Sarah contacts." },
          { id: "count", op: "count", from: "$search", dependsOn: [], purpose: "Count the matching contacts." }
        ]
      },
      usage: { modelCalls: 1, inputTokens: 30, outputTokens: 18, estimatedCostUsd: 0.001 }
    };
  }
};
const operationEngine = new AskAIEngine(providerStore, providerRegistry, "optimized", operationProvider);
const operationResponse = await operationEngine.chat({ sessionId: "test-provider-op", message: "Count contacts for Sarah" });
assert.equal(operationResponse.status, "completed");
assert.ok(operationResponse.trace.some((step) => step.actionId === "SYS.COUNT" && (step.output as { count?: number })?.count === 1), "generic count operation must consume a prior action result");
const invalidProviderPlan = validatePlanDocument({ steps: [{ id: "bad", action: "M50.A10", args: {}, dependsOn: [] }] }, providerRegistry.all(), [providerRegistry.get("M01.A01")!]);
assert.match(invalidProviderPlan.error ?? "", /retrieved candidate set/, "provider plans must stay within the retrieved candidate allowlist");
const invalidOperationPlan = validatePlanDocument({ steps: [{ id: "bad-op", op: "filter", args: {}, dependsOn: [] }] }, providerRegistry.all(), providerRegistry.all());
assert.match(invalidOperationPlan.error ?? "", /must declare a source/, "built-in operations must declare dataflow inputs");

const previewProvider: LLMProvider = {
  name: "fake-preview-planner",
  async rankActions() { return { actionIds: ["M01.A03", "M01.A05"], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; },
  async generatePlan() {
    return {
      plan: {
        intent: "Preview then archive contact",
        assumptions: [],
        clarification: null,
        unsupported: false,
        steps: [
          { id: "lookup", action: "M01.A03", args: { query: "Sarah" }, dependsOn: [], purpose: "Read the target before mutation." },
          { id: "archive", action: "M01.A05", args: { id: "M01-0001" }, dependsOn: ["lookup"], purpose: "Archive the confirmed contact." }
        ]
      },
      usage: { modelCalls: 1, inputTokens: 28, outputTokens: 20, estimatedCostUsd: 0.001 }
    };
  }
};
const previewStore = new MockStore(MODULES.map((module) => module.id));
const previewEngine = new AskAIEngine(previewStore, new ActionRegistry(), "optimized", previewProvider);
const previewResponse = await previewEngine.chat({ sessionId: "test-preview", message: "Search contacts for Sarah and archive contact M01-0001" });
assert.equal(previewResponse.status, "needs_confirmation");
assert.equal(previewResponse.confirmation?.estimatedMutationCount, 1);
assert.equal(previewResponse.confirmation?.safeReadResults[0]?.count, 1);
assert.ok(previewStore.get("M01", "M01-0001"), "read-first preview must not mutate state");
const previewConfirmed = await previewEngine.chat({ sessionId: "test-preview", message: "Confirm", confirmationToken: previewResponse.confirmationToken, planHash: previewResponse.confirmation?.planHash });
assert.equal(previewConfirmed.status, "completed");
assert.equal(previewStore.get("M01", "M01-0001"), undefined, "the confirmed plan must perform the archived mutation");

const scenarios = buildScenarios();
assert.ok(scenarios.length >= 100, "evaluation must contain at least 100 scenarios");
assert.equal(new Set(scenarios.map((scenario) => scenario.moduleId).filter(Boolean)).size, 50, "scenarios must cover all modules");
console.log(`PASS registry=500 smoke=${smokePassed} scenarios=${scenarios.length} behavioral=ok`);
