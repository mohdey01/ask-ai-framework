import { randomUUID } from "node:crypto";
import type { ActionDefinition, ChatRequest, ChatResponse, ConfirmationPreview, ExecutionMetrics, JsonObject, JsonValue, PlanStep, TraceStep, StoredRecord } from "./types.js";
import { ActionRegistry } from "./registry.js";
import { retrieveActions, retrieveBaseline } from "./retrieval.js";
import { MockStore } from "./store.js";
import type { LLMProvider, ProviderUsage } from "./provider.js";
import { StructuredPlanner } from "./planner.js";
import { hashPlan } from "./plan_hash.js";

interface SessionContext {
  selectedIds: string[];
  filters: JsonObject;
  lastPlan: PlanStep[];
  lastTaskIds: string[];
  lastResponse?: ChatResponse;
  pendingClarification?: { originalMessage: string; clarificationPrompt: string };
}

interface PendingConfirmation {
  token: string;
  sessionId: string;
  plan: PlanStep[];
  traceId: string;
  createdAt: number;
  planHash: string;
  preview: ConfirmationPreview;
}

const jsonObject = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const dataRecord = (value: unknown): StoredRecord | undefined => value && typeof value === "object" && !Array.isArray(value) && typeof (value as StoredRecord).id === "string" ? value as StoredRecord : undefined;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const normalizeMessage = (value: string): string => value.replace(/\b(creat|makee)\b/gi, "create").replace(/\bcontcat\b/gi, "contact").replace(/\bopportuntiy\b/gi, "opportunity").replace(/\binvoce\b/gi, "invoice").replace(/\bappointmnt\b/gi, "appointment").replace(/\bcalender\b/gi, "calendar").replace(/\bfolow\b/gi, "follow").replace(/\bremidner\b/gi, "reminder");
const frozenNow = (): Date => new Date(process.env.ASK_AI_NOW ?? "2026-01-01T00:00:00.000Z");
const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);

export class AskAIEngine {
  private static readonly confirmationTtlMs = 5 * 60_000;
  private readonly sessions = new Map<string, SessionContext>();
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly idempotentResponses = new Map<string, ChatResponse>();
  private readonly planner?: StructuredPlanner;
  private traceSequence = 0;

  constructor(readonly store: MockStore, readonly registry: ActionRegistry, readonly retrievalMode: "optimized" | "baseline" = "optimized", readonly provider?: LLMProvider) {
    this.planner = provider ? new StructuredPlanner(provider, registry.all()) : undefined;
  }

  reset(): void {
    this.store.reset();
    this.sessions.clear();
    this.pending.clear();
    this.idempotentResponses.clear();
  }

  private session(id: string): SessionContext {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const created: SessionContext = { selectedIds: [], filters: {}, lastPlan: [], lastTaskIds: [] };
    this.sessions.set(id, created);
    return created;
  }

  private nextTrace(): string { this.traceSequence += 1; return `TRC-${String(this.traceSequence).padStart(5, "0")}-${randomUUID().slice(0, 6)}`; }

  async chat(request: ChatRequest, onProgress?: (step: TraceStep) => void): Promise<ChatResponse> {
    const started = performance.now();
    const traceId = this.nextTrace();
    const context = this.session(request.sessionId);
    const message = request.message.trim();
    const normalized = normalizeMessage(message);
    const idempotencyKey = request.idempotencyKey ? `${request.sessionId}:${request.idempotencyKey}` : undefined;
    const cached = idempotencyKey ? this.idempotentResponses.get(idempotencyKey) : undefined;
    if (cached) return clone(cached);
    const remember = (response: ChatResponse): ChatResponse => { if (idempotencyKey) this.idempotentResponses.set(idempotencyKey, clone(response)); return response; };
    let providerUsage: ProviderUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    let executionMode: ChatResponse["executionMode"] = this.planner ? "provider" : "offline";
    let providerError: string | undefined;
    const finish = (response: ChatResponse): ChatResponse => { response.executionMode = executionMode; response.metrics.modelCalls += providerUsage.modelCalls; response.metrics.inputTokens += providerUsage.inputTokens; response.metrics.outputTokens += providerUsage.outputTokens; response.metrics.estimatedCostUsd += providerUsage.estimatedCostUsd; if (providerError) response.providerError = { message: providerError }; return remember(response); };
    if (!message) return remember(this.baseResponse(traceId, "needs_clarification", "Tell me what you would like me to do.", [], [], started, message));

    if (request.confirmationToken) {
      const pending = this.pending.get(request.confirmationToken);
      if (!pending || pending.sessionId !== request.sessionId) return remember(this.baseResponse(traceId, "needs_clarification", "That confirmation has expired. Please repeat the request.", [], [], started, message));
      if (Date.now() - pending.createdAt > AskAIEngine.confirmationTtlMs) {
        this.pending.delete(request.confirmationToken);
        return finish(this.baseResponse(traceId, "needs_clarification", "That confirmation has expired. Please repeat the request.", [], [], started, message));
      }
      if (request.cancelConfirmation) {
        this.pending.delete(request.confirmationToken);
        return finish(this.baseResponse(traceId, "cancelled", "The protected plan was cancelled. No mutation was executed.", pending.plan, [], started, message));
      }
      if (request.planHash !== pending.planHash) {
        const response = this.baseResponse(traceId, "needs_confirmation", "The confirmation hash is missing or does not match the preview. Review the unchanged preview and confirm that exact plan.", pending.plan, [], started, message);
        response.confirmationToken = pending.token;
        response.confirmation = pending.preview;
        return finish(response);
      }
      this.pending.delete(request.confirmationToken);
      return finish(await this.execute(request.sessionId, pending.plan, traceId, started, message, context, onProgress));
    }

    if (!this.planner && this.isUnsupported(normalized)) return finish(this.baseResponse(traceId, "unsupported", "I cannot complete that request with the available business tools, so I have not invented a result.", [], [], started, message));

    let effectiveMessage = normalized;
    if (context.pendingClarification && !/^(?:create|search|find|list|show|get|delete|archive|cancel|update|book)\b/i.test(normalized)) {
      effectiveMessage = /\b(named|called|with)\b/i.test(normalized)
        ? `${context.pendingClarification.originalMessage} ${normalized}`
        : `${context.pendingClarification.originalMessage} named ${normalized}`;
    }

    let planResult: { plan: PlanStep[]; clarification?: string; unsupported?: boolean };
    if (this.planner) {
      try {
        const candidates = this.retrievalMode === "baseline"
          ? this.registry.all()
          : retrieveActions(effectiveMessage, this.registry.all(), 20).map((hit) => this.registry.get(hit.actionId)).filter((action): action is ActionDefinition => Boolean(action));
        const generated = await this.planner.generate({
          message: effectiveMessage,
          candidates,
          sessionId: request.sessionId,
          context: {
            selectedIds: context.selectedIds,
            filters: context.filters,
            lastTaskIds: context.lastTaskIds,
            lastPlan: JSON.parse(JSON.stringify(context.lastPlan))
          }
        });
        providerUsage = generated.usage;
        planResult = { plan: generated.plan, clarification: generated.document.clarification ?? undefined, unsupported: generated.document.unsupported };
      } catch (error) {
        providerError = error instanceof Error ? error.message : "provider unavailable";
        context.filters.providerFallback = providerError;
        executionMode = "provider_fallback";
        planResult = this.buildPlan(effectiveMessage, context);
      }
    } else {
      planResult = this.buildPlan(effectiveMessage, context);
    }

    if (planResult.clarification) {
      context.pendingClarification = {
        originalMessage: context.pendingClarification?.originalMessage ?? normalized,
        clarificationPrompt: planResult.clarification
      };
      return finish(this.baseResponse(traceId, "needs_clarification", planResult.clarification, planResult.plan, [], started, message));
    }
    context.pendingClarification = undefined;
    if (planResult.unsupported) return finish(this.baseResponse(traceId, "unsupported", "I cannot complete that request with the available business tools, so I have not invented a result.", [], [], started, message));
    if (!planResult.plan.length) return finish(this.baseResponse(traceId, "unsupported", "I could not map that request to a supported action. Try naming the business outcome, such as creating a contact or searching invoices.", [], [], started, message));

    if (executionMode === "provider_fallback" && this.planMutatesState(planResult.plan)) {
      return finish(this.baseResponse(traceId, "provider_unavailable", "The AI provider is unavailable, so no state-changing action was executed. Please retry the request.", planResult.plan, [], started, message));
    }

    const protectedStep = planResult.plan.find((step) => {
      const action = this.registry.get(step.actionId);
      return action?.confirmation === "required" || Boolean(step.forEachFrom && action && ["create", "update", "archive", "delete", "message", "financial", "relationship", "transition"].includes(action.operation));
    });
    const protectedAction = protectedStep ? this.registry.get(protectedStep.actionId) : undefined;
    if (protectedAction) {
      const token = `CONF-${randomUUID().slice(0, 12)}`;
      const preview = await this.previewPlan(planResult.plan);
      this.pending.set(token, { token, sessionId: request.sessionId, plan: planResult.plan, traceId, createdAt: Date.now(), planHash: preview.planHash, preview });
      const target = preview.targetRecords[0];
      const targetSummary = target ? ` Target: ${target.name ?? target.id}${target.email ? ` (${target.email})` : ""} [${target.id}].` : "";
      const response = this.baseResponse(traceId, "needs_confirmation", `This will perform the protected action “${protectedAction.name}”.${targetSummary} Confirm the ${preview.estimatedMutationCount} estimated mutation${preview.estimatedMutationCount === 1 ? "" : "s"} after reviewing the preview.`, planResult.plan, [], started, message);
      response.confirmationToken = token;
      response.confirmation = preview;
      return finish(response);
    }
    return finish(await this.execute(request.sessionId, planResult.plan, traceId, started, message, context, onProgress));
  }

  private isUnsupported(message: string): boolean {
    return /weather|flight|recipe|stock price|write my essay|play music|medical diagnosis|legal advice/.test(message.toLowerCase());
  }

  private planMutatesState(plan: PlanStep[]): boolean {
    return plan.some((step) => {
      const action = this.registry.get(step.actionId);
      return Boolean(action && !["read", "search", "report"].includes(action.operation));
    });
  }

  private resolveDate(message: string, fallbackDays = 4): string {
    const explicit = message.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (explicit?.[1]) return explicit[1];
    const base = frozenNow();
    const offset = /day after tomorrow/.test(message) ? 2 : /tomorrow/.test(message) ? 1 : /next week/.test(message) ? 7 : fallbackDays;
    base.setUTCDate(base.getUTCDate() + offset);
    return dateOnly(base);
  }

  private resolveEntityId(message: string, moduleId: string, context: SessionContext): string | undefined {
    const explicit = message.match(/\b(M\d{2}-\d{4})\b/i)?.[1];
    if (explicit && this.store.get(moduleId, explicit.toUpperCase())) return explicit.toUpperCase();
    const lowerMessage = message.toLowerCase();
    const named = this.store.list(moduleId).find((record) => [record.name, record.email].some((value) => typeof value === "string" && lowerMessage.includes(value.toLowerCase())));
    if (named) return named.id;
    return context.selectedIds.find((id) => this.store.get(moduleId, id));
  }

  /** Execute only read/report steps to produce a truthful confirmation preview. */
  private async previewPlan(plan: PlanStep[]): Promise<ConfirmationPreview> {
    const outputs = new Map<string, unknown>();
    const safeReadResults: ConfirmationPreview["safeReadResults"] = [];
    const recordsFrom = (value: unknown): StoredRecord[] => Array.isArray(value) ? value.map(dataRecord).filter((record): record is StoredRecord => Boolean(record)) : (() => { const record = dataRecord(value); return record ? [record] : []; })();
    const planHash = hashPlan(plan);
    for (const step of plan) {
      const action = this.registry.get(step.actionId);
      if (!action || !["read", "search", "report"].includes(action.operation)) continue;
      const input = this.resolveInput(step.input, outputs);
      const result = await this.registry.execute(action.id, input, { store: this.store, traceId: "PREVIEW-" + planHash.slice(0, 12), stepId: "preview:" + step.stepId });
      if (!result.ok) continue;
      outputs.set(step.stepId, result.data);
      const records = recordsFrom(result.data);
      const resultObject = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : undefined;
      const count = Array.isArray(result.data) ? records.length : typeof resultObject?.count === "number" ? resultObject.count : records.length;
      safeReadResults.push({ stepId: step.stepId, count, sampleRecordIds: records.slice(0, 5).map((record) => record.id) });
    }
    const actions = plan.map((step) => ({ step, action: this.registry.get(step.actionId) })).filter(({ step, action }) => action?.confirmation === "required" || Boolean(step.forEachFrom && action && ["create", "update", "archive", "delete", "message", "financial", "relationship", "transition"].includes(action.operation))).map(({ step, action }) => {
      if (!action) throw new Error("Confirmation preview found an invalid action.");
      const sourceRecords = step?.forEachFrom ? recordsFrom(outputs.get(step.forEachFrom)) : [];
      const excludedRecords = step?.excludeBy ? recordsFrom(outputs.get(step.excludeBy)) : [];
      const relationField = step?.excludeField ?? "id";
      const eligibleCount = excludedRecords.length ? sourceRecords.filter((record) => !excludedRecords.some((candidate) => (record[relationField] !== undefined && candidate[relationField] === record[relationField]) || (record[relationField] !== undefined && candidate.contactId === record[relationField]) || candidate.id === record[relationField])).length : sourceRecords.length;
      const sourceCount = step?.forEachFrom ? eligibleCount : 0;
      return { actionId: action.id, actionName: action.name, operation: action.operation, estimatedCount: sourceCount || 1 };
    });
    const targetRecords = plan.map((step) => ({ step, action: this.registry.get(step.actionId) }))
      .filter(({ step, action }) => action?.confirmation === "required" || Boolean(step.forEachFrom && action && ["create", "update", "archive", "delete", "message", "financial", "relationship", "transition"].includes(action.operation)))
      .flatMap(({ step, action }) => {
        if (!action) return [];
        const input = this.resolveInput(step.input, outputs);
        const sourceRecords = step.forEachFrom ? recordsFrom(outputs.get(step.forEachFrom)) : [];
        const ids = sourceRecords.length
          ? sourceRecords.map((record) => record.id)
          : [input.id, jsonObject(input.fields).id].filter((id): id is string => typeof id === "string");
        return ids.slice(0, 10).flatMap((id) => {
          const record = this.store.get(action.moduleId, id);
          if (!record) return [];
          return [{ actionId: action.id, actionName: action.name, moduleName: action.moduleName, id: record.id, ...(typeof record.name === "string" ? { name: record.name } : {}), ...(typeof record.email === "string" ? { email: record.email } : {}) }];
        });
      });
    return {
      planHash,
      actions,
      estimatedMutationCount: actions.reduce((total, action) => total + action.estimatedCount, 0),
      sampleRecordIds: [...new Set([...safeReadResults.flatMap((result) => result.sampleRecordIds), ...targetRecords.map((record) => record.id)])].slice(0, 10),
      targetRecords,
      safeReadResults
    };
  }

  private buildPlan(message: string, context: SessionContext, providerHints: string[] = []): { plan: PlanStep[]; clarification?: string } {
    const lower = message.toLowerCase();
    const plan: PlanStep[] = [];
    const add = (actionId: string, input: JsonObject, purpose: string, dependsOn: string[] = [], options: Pick<PlanStep, "forEachFrom" | "excludeBy" | "excludeField"> = {}) => plan.push({ stepId: `STEP-${plan.length + 1}`, actionId, input, purpose, dependsOn, ...options });

    if (context.lastTaskIds.length && /\b(those|these|same)\b.*\btasks?\b|\btasks?\b.*\bdue\b/.test(lower)) {
      for (const id of context.lastTaskIds) add("M06.A06", { id, fields: { dueDate: this.resolveDate(message, 1) } }, "Apply the follow-up due-date constraint.");
      return { plan };
    }

    const hits = this.retrievalMode === "baseline" ? retrieveBaseline(message, this.registry.all(), 50) : retrieveActions(message, this.registry.all(), 20);
    const providerAction = providerHints.map((actionId) => this.registry.get(actionId)).find((action): action is ActionDefinition => Boolean(action));
    const best = providerAction ? { actionId: providerAction.id, score: Number.POSITIVE_INFINITY } : hits[0];
    if (!best || best.score < 2) return { plan };
    const action = this.registry.get(best.actionId);
    if (!action) return { plan };
    const candidateActions = hits.map((hit) => this.registry.get(hit.actionId)).filter((candidate): candidate is ActionDefinition => Boolean(candidate));
    const hasWorkflowConjunction = /\b(and|then|exclude|skip|unless|each|every|per)\b/.test(lower);
    const readActions = candidateActions.filter((candidate) => candidate.operation === "search" || candidate.operation === "read");
    const createActions = candidateActions.filter((candidate) => candidate.operation === "create");
    const writeAction = createActions.find((candidate) => new RegExp(`(?:create|add|make|draft)[^,.]{0,30}${candidate.moduleName.replace(/s$/, "s?").replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`, "i").test(message)) ?? createActions.find((candidate) => candidate.searchTerms.some((term) => term.length > 4 && lower.includes(term)));
    if (hasWorkflowConjunction && readActions.length >= 2 && writeAction) {
      const modulePosition = (candidate: ActionDefinition): number => {
        const singular = candidate.moduleName.toLowerCase().replace(/s$/, "");
        return lower.indexOf(singular) < 0 ? Number.MAX_SAFE_INTEGER : lower.indexOf(singular);
      };
      const relatedReads = readActions;
      const mentionedReads = relatedReads.filter((candidate) => modulePosition(candidate) !== Number.MAX_SAFE_INTEGER);
      const orderedReads = (mentionedReads.length >= 2 ? mentionedReads : relatedReads).sort((left, right) => modulePosition(left) - modulePosition(right));
      const firstRead = orderedReads[0];
      const secondRead = orderedReads.find((candidate) => candidate.moduleId !== firstRead?.moduleId);
      if (firstRead && secondRead) {
        const firstStep = `STEP-${plan.length + 1}`;
        add(firstRead.id, { query: this.workflowQuery(message, firstRead) }, `Retrieve source ${firstRead.moduleName.toLowerCase()} records.`);
        const secondStep = `STEP-${plan.length + 1}`;
        add(secondRead.id, { query: this.workflowQuery(message, secondRead) }, `Retrieve comparison ${secondRead.moduleName.toLowerCase()} records.`, [firstStep]);
        const relationField = this.sharedRelationField(firstRead.moduleId, secondRead.moduleId) ?? "id";
        const fields: JsonObject = { source: "Ask AI workflow", sourceSteps: [firstStep, secondStep], description: "Created from eligible source records", dueDate: this.resolveDate(message) };
        add(writeAction.id, { name: `${writeAction.name} workflow`, fields }, `Create one ${writeAction.moduleName.toLowerCase()} per eligible source record.`, [firstStep, secondStep], { forEachFrom: firstStep, excludeBy: secondStep, excludeField: relationField });
        return { plan };
      }
    }
    const id = this.resolveEntityId(message, action.moduleId, context);
    if (["read", "update", "archive", "delete", "relationship", "transition", "message", "financial", "schedule", "report"].includes(action.operation) && action.inputSchema.fields.id && !id && context.selectedIds[0]) {
      add(action.id, { id: context.selectedIds[0], fields: { note: message } }, `Apply the request to the previously selected record.`);
    } else if (action.operation === "create") {
      const named = message.match(/\b(?:named|called)\s+(.+?)(?:\s+with\s+|\s+for\s+|$)/i)?.[1]?.trim();
      if (action.inputSchema.fields.name?.required && !named) return { plan, clarification: `What name should I use for the ${action.moduleName.toLowerCase()}?` };
      const name = named || message.replace(/^(please\s+)?(?:create|add|make|draft)\s+/i, "").slice(0, 80);
      const email = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
      add(action.id, { name, fields: { name, ...(email ? { email } : {}), source: "Ask AI" } }, `Create a ${action.moduleName.toLowerCase()} record.`);
    } else if (action.operation === "search" || action.operation === "read") {
      const query = this.extractQuery(message, action.name, action.moduleName, id);
      add(action.id, { ...(id ? { id } : {}), query }, `Retrieve matching ${action.moduleName.toLowerCase()} data.`);
    } else {
      add(action.id, { ...(id ? { id } : {}), fields: { note: message } }, `Execute ${action.name.toLowerCase()}.`);
    }
    return { plan };
  }

  private extractQuery(message: string, actionName: string, moduleName: string, id?: string): string {
    if (id) return message;
    const escapedAction = actionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedModule = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cleaned = message
      .replace(new RegExp(`^\\s*(?:please\\s+)?${escapedAction}\\b`, "i"), "")
      .replace(new RegExp(`^\\s*(?:in|for|of|on)\\s+${escapedModule}\\b`, "i"), "")
      .replace(new RegExp(`^\\s*(?:${escapedModule})\\b`, "i"), "")
      .replace(/^\s*(?:for|about|matching|named|called)\s+/i, "")
      .trim();
    return cleaned || message;
  }

  private workflowQuery(message: string, action: ActionDefinition): string {
    const lower = message.toLowerCase();
    const module = action.moduleName.toLowerCase();
    const statusTerms = ["booked", "overdue", "unpaid", "reminder", "quiet", "active", "open", "draft"];
    const modulePosition = lower.indexOf(module.replace(/s$/, ""));
    const status = statusTerms.filter((term) => lower.includes(term)).sort((left, right) => Math.abs(lower.indexOf(left) - modulePosition) - Math.abs(lower.indexOf(right) - modulePosition))[0];
    if (status && this.store.list(action.moduleId).some((record) => JSON.stringify(record).toLowerCase().includes(status))) return status;
    return action.moduleId;
  }

  private sharedRelationField(leftModuleId: string, rightModuleId: string): string | undefined {
    const left = this.store.list(leftModuleId);
    const right = this.store.list(rightModuleId);
    const fields = ["contactId", "customerId", "companyId", "leadId", "invoiceId", "ownerId"];
    return fields.find((field) => left.some((leftRecord) => {
      const value = leftRecord[field];
      return typeof value === "string" && right.some((rightRecord) => rightRecord[field] === value);
    }));
  }

  private async execute(sessionId: string, plan: PlanStep[], traceId: string, started: number, message: string, context: SessionContext, onProgress?: (step: TraceStep) => void): Promise<ChatResponse> {
    const trace: TraceStep[] = [];
    const outputs = new Map<string, unknown>();
    const completed = new Set<string>();
    const failed = new Set<string>();
    const pending = [...plan];
    let retries = 0;
    let firstUsefulResponseMs: number | undefined;
    const recordsFrom = (value: unknown): StoredRecord[] => Array.isArray(value) ? value.map(dataRecord).filter((record): record is StoredRecord => Boolean(record)) : (() => { const record = dataRecord(value); return record ? [record] : []; })();
    const appendTrace = (item: TraceStep): void => {
      trace.push(item);
      if (firstUsefulResponseMs === undefined && item.status !== "skipped") firstUsefulResponseMs = performance.now() - started;
      onProgress?.(item);
    };
    const executeOne = async (actionId: string, input: JsonObject, stepId: string, action: ActionDefinition): Promise<{ result: Awaited<ReturnType<ActionRegistry["execute"]>>; durationMs: number }> => {
      const startedStep = performance.now();
      let result = await this.registry.execute(actionId, input, { store: this.store, traceId, stepId });
      if (!result.ok && (action.operation === "read" || action.operation === "search")) {
        retries += 1;
        result = await this.registry.execute(actionId, input, { store: this.store, traceId, stepId: `${stepId}.retry1` });
      }
      return { result, durationMs: Math.round((performance.now() - startedStep) * 100) / 100 };
    };
    const executeBuiltin = (step: PlanStep): JsonValue => {
      const source = recordsFrom(outputs.get(step.fromStep ?? step.dependsOn[0] ?? ""));
      const comparison = recordsFrom(outputs.get(step.againstStep ?? step.excludeBy ?? ""));
      const field = step.field ?? step.excludeField ?? "id";
      const valueAt = (record: StoredRecord): unknown => record[field];
      const matches = (record: StoredRecord): boolean => {
        const value = valueAt(record);
        if (step.equals !== undefined) return value === step.equals;
        if (step.contains !== undefined) return String(value ?? "").toLowerCase().includes(step.contains.toLowerCase());
        return Boolean(value);
      };
      if (step.op === "filter") return source.filter(matches);
      if (step.op === "exclude") return source.filter((record) => !comparison.some((candidate) => valueAt(candidate) === valueAt(record)));
      if (step.op === "join") {
        return source.map((record) => ({ ...record, joined: comparison.filter((candidate) => valueAt(candidate) === valueAt(record)) }));
      }
      if (step.op === "count") return { count: source.length };
      if (step.op === "limit") return source.slice(0, step.limit ?? 10);
      if (step.op === "sort") {
        return [...source].sort((left, right) => {
          const a = valueAt(left);
          const b = valueAt(right);
          const comparisonResult = String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
          return step.descending ? -comparisonResult : comparisonResult;
        });
      }
      throw new Error("Unsupported built-in operation " + step.op);
    };
    while (pending.length) {
      const index = pending.findIndex((step) => step.dependsOn.every((dependency) => completed.has(dependency) || failed.has(dependency)));
      if (index < 0) break;
      const step = pending.splice(index, 1)[0];
      if (!step) break;
      if (step.op) {
        try {
          const output = executeBuiltin(step);
          completed.add(step.stepId);
          outputs.set(step.stepId, output);
          appendTrace({ stepId: step.stepId, actionId: step.actionId, actionName: `Built-in ${step.op}`, status: "success", input: step.input, output, durationMs: 0, dependsOn: step.dependsOn });
        } catch (error) {
          failed.add(step.stepId);
          appendTrace({ stepId: step.stepId, actionId: step.actionId, actionName: `Built-in ${step.op}`, status: "failed", input: step.input, error: { code: "PLAN_OPERATION_FAILED", message: error instanceof Error ? error.message : "Plan operation failed." }, durationMs: 0, dependsOn: step.dependsOn });
        }
        continue;
      }
      const action = this.registry.get(step.actionId);
      if (!action) { failed.add(step.stepId); appendTrace({ stepId: step.stepId, actionId: step.actionId, actionName: "Unknown action", status: "failed", input: step.input, error: { code: "UNKNOWN_ACTION", message: "Action is not registered." }, durationMs: 0, dependsOn: step.dependsOn }); continue; }
      const dependencyFailed = step.dependsOn.some((dependency) => failed.has(dependency));
      if (dependencyFailed) { appendTrace({ stepId: step.stepId, actionId: step.actionId, actionName: action.name, status: "skipped", input: step.input, error: { code: "DEPENDENCY_FAILED", message: "A required prior step failed." }, durationMs: 0, dependsOn: step.dependsOn }); continue; }
      const baseInput = this.resolveInput(step.input, outputs);
      let inputs = [baseInput];
      if (step.forEachFrom) {
        const source = recordsFrom(outputs.get(step.forEachFrom));
        const excluded = step.excludeBy ? recordsFrom(outputs.get(step.excludeBy)) : [];
        const field = step.excludeField ?? "id";
        const eligible = source.filter((item) => {
          const key = item[field];
          return !excluded.some((candidate) => (key !== undefined && candidate[field] === key) || (key !== undefined && candidate.contactId === key) || candidate.id === key);
        });
        inputs = eligible.map((item) => ({ ...baseInput, fields: { ...jsonObject(baseInput.fields), sourceRecordId: item.id, ...(item.contactId ? { contactId: item.contactId } : {}), ...(item.customerId ? { customerId: item.customerId } : {}) } }));
        if (!inputs.length) {
          const emptyTrace: TraceStep = { stepId: step.stepId, actionId: step.actionId, actionName: action.name, status: "success", input: baseInput, output: [], durationMs: 0, dependsOn: step.dependsOn };
          completed.add(step.stepId);
          outputs.set(step.stepId, []);
          appendTrace(emptyTrace);
          continue;
        }
      }
      const stepOutputs: unknown[] = [];
      let stepFailed = false;
      for (const [inputIndex, input] of inputs.entries()) {
        const stepId = inputs.length > 1 ? `${step.stepId}.${inputIndex + 1}` : step.stepId;
        const execution = await executeOne(step.actionId, input, stepId, action);
        if (execution.result.ok) {
          stepOutputs.push(execution.result.data);
          appendTrace({ stepId, actionId: step.actionId, actionName: action.name, status: "success", input, output: execution.result.data, durationMs: execution.durationMs, dependsOn: step.dependsOn });
        } else {
          stepFailed = true;
          appendTrace({ stepId, actionId: step.actionId, actionName: action.name, status: "failed", input, error: execution.result.error, durationMs: execution.durationMs, dependsOn: step.dependsOn });
        }
      }
      if (stepFailed) failed.add(step.stepId); else completed.add(step.stepId);
      outputs.set(step.stepId, inputs.length > 1 ? stepOutputs : stepOutputs[0]);
    }
    for (const step of pending) {
      const action = this.registry.get(step.actionId);
      appendTrace({ stepId: step.stepId, actionId: step.actionId, actionName: action?.name ?? "Unknown action", status: "skipped", input: step.input, error: { code: "UNRESOLVED_DEPENDENCY", message: "Dependencies could not be resolved." }, durationMs: 0, dependsOn: step.dependsOn });
    }
    const success = trace.filter((item) => item.status === "success");
    const failures = trace.filter((item) => item.status === "failed");
    const selectedIds = [...new Set(success.flatMap((item) => recordsFrom(item.output).map((record) => record.id)))];
    context.selectedIds = selectedIds.length ? selectedIds : context.selectedIds;
    context.lastTaskIds = success.filter((item) => item.actionId === "M06.A01").flatMap((item) => recordsFrom(item.output).map((record) => record.id));
    context.lastPlan = plan;
    const status = failures.length ? "partial" : "completed";
    const response = this.baseResponse(traceId, status, this.summarize(status, success, failures), plan, trace, started, message);
    response.metrics.retries = retries;
    response.metrics.firstUsefulResponseMs = Math.round((firstUsefulResponseMs ?? response.metrics.requestMs) * 100) / 100;
    context.lastResponse = response;
    return response;
  }

  private resolveInput(input: JsonObject, outputs: Map<string, unknown>): JsonObject {
    const resolved = JSON.parse(JSON.stringify(input)) as JsonObject;
    const walk = (value: JsonObject | JsonValueLike): JsonValueLike => {
      if (typeof value === "string" && value.startsWith("$STEP-")) {
        const [, stepId, field] = value.match(/^\$(STEP-\d+)\.(.+)$/) ?? [];
        const output = stepId ? outputs.get(stepId) : undefined;
        if (field && output && typeof output === "object" && !Array.isArray(output)) return (output as Record<string, unknown>)[field] as JsonValueLike;
      }
      if (Array.isArray(value)) return value.map((item) => walk(item as JsonValueLike));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item as JsonValueLike)])) as JsonObject;
      return value;
    };
    return walk(resolved) as JsonObject;
  }

  private summarize(status: ChatResponse["status"], success: TraceStep[], failures: TraceStep[]): string {
    if (status === "completed") {
      const details = success.map((step) => {
        if (Array.isArray(step.output)) return `${step.actionName}: ${step.output.length} result${step.output.length === 1 ? "" : "s"}`;
        if (step.output && typeof step.output === "object") {
          const output = step.output as Record<string, unknown>;
          if (typeof output.id === "string") return `${step.actionName}: ${output.name ? `${output.name} (${output.id})` : output.id}`;
          if (typeof output.count === "number") return `${step.actionName}: ${output.count} result${output.count === 1 ? "" : "s"}`;
        }
        return step.actionName;
      });
      return `Completed ${success.length} step${success.length === 1 ? "" : "s"}. ${details.join("; ")}. Results are from the simulated store.`;
    }
    if (success.length) return `Partially completed: ${success.length} step${success.length === 1 ? "" : "s"} succeeded; ${failures.length} failed. Review the execution trace for details.`;
    return `No steps completed. ${failures.map((step) => step.error?.message).join(" ")}`;
  }

  private baseResponse(traceId: string, status: ChatResponse["status"], message: string, plan: PlanStep[], trace: TraceStep[], started: number, input: string): ChatResponse {
    const requestMs = Math.round((performance.now() - started) * 100) / 100;
    const metrics: ExecutionMetrics = { requestMs, firstUsefulResponseMs: requestMs, modelCalls: 0, retries: 0, inputTokens: Math.ceil(input.length / 4), outputTokens: Math.ceil(message.length / 4), estimatedCostUsd: 0 };
    return { traceId, status, message, plan, trace, metrics, context: { selectedIds: [], filters: {} }, executionMode: "offline" };
  }
}

type JsonValueLike = string | number | boolean | null | JsonObject | JsonValueLike[] | undefined;
