import type { ActionDefinition, JsonObject } from "./types.js";

export interface ProviderUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ProviderRankResult {
  actionIds: string[];
  usage: ProviderUsage;
}

export interface ProviderPlanRequest {
  message: string;
  candidates: ActionDefinition[];
  context: JsonObject;
  /** Stable conversation identifier used by providers such as OpenCode Go. */
  sessionId?: string;
}

export interface ProviderPlanResult {
  plan: unknown;
  usage: ProviderUsage;
}

export interface LLMProvider {
  readonly name: string;
  rankActions(message: string, actions: ActionDefinition[], sessionId?: string): Promise<ProviderRankResult>;
  generatePlan(request: ProviderPlanRequest): Promise<ProviderPlanResult>;
}

interface ProviderHttpResult {
  ok: boolean;
  status: number;
  payload?: unknown;
}

/**
 * Optional provider adapter. The engine treats provider output as untrusted planning input;
 * schemas, permissions, state transitions, and final truth remain deterministic.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";

  private static readonly requestTimeoutMs = 35_000;
  private static readonly retryBudgetMs = 40_000;
  private static readonly maxAttempts = 2;

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.ASK_AI_MODEL ?? "gpt-4o-mini",
    private readonly endpoint = process.env.ASK_AI_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions"
  ) {}

  private estimatedCost(inputTokens: number, outputTokens: number): number {
    const inputRate = Number(process.env.ASK_AI_INPUT_COST_PER_1M ?? 0);
    const outputRate = Number(process.env.ASK_AI_OUTPUT_COST_PER_1M ?? 0);
    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
  }

  private sessionHeaders(sessionId?: string): Record<string, string> {
    const resolvedSessionId = sessionId ?? process.env.ASK_AI_SESSION_ID ?? `session-${Date.now()}`;
    return { "x-opencode-session": resolvedSessionId };
  }

  private isTransientNetworkError(error: unknown): boolean {
    // A request deadline is a hard guardrail, not a reason to start another
    // potentially slow request. Retry fetch transport failures, but let our
    // 35-second deadline fail fast and surface provider unavailability.
    return error instanceof TypeError || (error instanceof Error && ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETRESET"].includes(error.name));
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const exponentialDelay = 1_500 * (2 ** attempt);
    const jitter = Math.floor(Math.random() * 1_500);
    await new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitter));
  }

  private async readJson(response: Response, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const body = await Promise.race([
        response.text(),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            const error = new Error("LLM provider response body timed out.");
            error.name = "TimeoutError";
            reject(error);
          }, timeoutMs);
        })
      ]);
      return JSON.parse(body);
    } catch (error) {
      // Do not await cancellation: some providers leave a stalled body stream
      // open even after the deadline. The caller must regain control at the
      // timeout boundary while cancellation proceeds in the background.
      if (timedOut) void response.body?.cancel().catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchWithDeadline(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetch(input, init),
        new Promise<Response>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("LLM provider request timed out.");
            error.name = "TimeoutError";
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async post(body: JsonObject, sessionId?: string): Promise<ProviderHttpResult> {
    let lastError: unknown;
    const startedAt = Date.now();
    for (let attempt = 0; attempt < OpenAICompatibleProvider.maxAttempts; attempt += 1) {
      try {
        const remainingBudgetMs = OpenAICompatibleProvider.retryBudgetMs - (Date.now() - startedAt);
        if (remainingBudgetMs <= 0) throw new Error("LLM provider retry budget exhausted.");
        const requestDeadline = AbortSignal.timeout(OpenAICompatibleProvider.requestTimeoutMs);
        const budgetDeadline = AbortSignal.timeout(Math.min(OpenAICompatibleProvider.requestTimeoutMs, remainingBudgetMs));
        const response = await this.fetchWithDeadline(this.endpoint, {
          method: "POST",
          signal: AbortSignal.any([requestDeadline, budgetDeadline]),
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            ...this.sessionHeaders(sessionId)
          },
          body: JSON.stringify(body)
        }, Math.min(OpenAICompatibleProvider.requestTimeoutMs, Math.max(1, remainingBudgetMs)));
        if (response.ok) {
          const remainingBodyBudgetMs = OpenAICompatibleProvider.retryBudgetMs - (Date.now() - startedAt);
          const payload = await this.readJson(response, Math.min(OpenAICompatibleProvider.requestTimeoutMs, Math.max(1, remainingBodyBudgetMs)));
          return { ok: true, status: response.status, payload };
        }
        if (![429, 503].includes(response.status) || attempt === OpenAICompatibleProvider.maxAttempts - 1) {
          // Do not let a provider-owned response stream hold the request open.
          // The retry/deadline budget belongs to the caller, not the remote body.
          void response.body?.cancel().catch(() => undefined);
          return { ok: false, status: response.status };
        }
        void response.body?.cancel().catch(() => undefined);
        const retryRemainingMs = OpenAICompatibleProvider.retryBudgetMs - (Date.now() - startedAt);
        const retryDelayMs = 1_500 * (2 ** attempt) + Math.floor(Math.random() * 1_500);
        if (retryRemainingMs <= retryDelayMs) return response;
        await this.waitBeforeRetry(attempt);
      } catch (error) {
        lastError = error;
        if (!this.isTransientNetworkError(error) || attempt === OpenAICompatibleProvider.maxAttempts - 1) throw error;
        if (OpenAICompatibleProvider.retryBudgetMs - (Date.now() - startedAt) <= 0) throw error;
        await this.waitBeforeRetry(attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("LLM provider request failed.");
  }

  async rankActions(message: string, actions: ActionDefinition[], sessionId?: string): Promise<ProviderRankResult> {
    const compactCatalog = actions.map((action) => ({ id: action.id, module: action.moduleName, name: action.name, description: action.description }));
    const requestPayload = { message, catalog: compactCatalog };
    const response = await this.post({
      model: this.model,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return JSON only: {\"actionIds\":[string]}. Rank up to five relevant IDs from the supplied catalog. Never invent IDs." },
        { role: "user", content: JSON.stringify(requestPayload) }
      ]
    }, sessionId);
    if (!response.ok) throw new Error(`LLM provider returned HTTP ${response.status}`);
    const payload = response.payload as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM provider returned no ranked actions.");
    const parsed = JSON.parse(content) as { actionIds?: unknown };
    const validIds = new Set(actions.map((action) => action.id));
    const actionIds = Array.isArray(parsed.actionIds) ? parsed.actionIds.filter((id): id is string => typeof id === "string" && validIds.has(id)).slice(0, 5) : [];
    const inputTokens = payload.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(requestPayload).length / 4);
    const outputTokens = payload.usage?.completion_tokens ?? Math.ceil(content.length / 4);
    return { actionIds, usage: { modelCalls: 1, inputTokens, outputTokens, estimatedCostUsd: this.estimatedCost(inputTokens, outputTokens) } };
  }

  async generatePlan(request: ProviderPlanRequest): Promise<ProviderPlanResult> {
    const indirectFollowUpIds = ["M03.A03", "M21.A03", "M06.A01"];
    const lowerMessage = request.message.toLowerCase();
    const isIndirectLeadFollowUp = /\bleads?\b/.test(lowerMessage) && /\b(follow[- ]?up|quiet|booked appointments?|tasks?)\b/.test(lowerMessage);
    const prioritizedCandidates = isIndirectLeadFollowUp ? [...request.candidates].sort((left, right) => {
      const leftPriority = indirectFollowUpIds.indexOf(left.id);
      const rightPriority = indirectFollowUpIds.indexOf(right.id);
      return (leftPriority < 0 ? indirectFollowUpIds.length : leftPriority) - (rightPriority < 0 ? indirectFollowUpIds.length : rightPriority);
    }) : request.candidates;
    const compactCatalog = prioritizedCandidates.map((action) => ({
      id: action.id,
      module: action.moduleName,
      name: action.name,
      description: action.description,
      operation: action.operation,
      confirmation: action.confirmation,
      params: Object.keys(action.inputSchema.fields || {})
    }));
    const system = [
      "You are the planning component of a business automation agent.",
      "Return JSON only. Never invent action IDs; use only the supplied candidates.",
      "Return this shape: {\"intent\":string,\"assumptions\":string[],\"clarification\":string|null,\"unsupported\":boolean,\"steps\":[{\"id\":string,\"action\":string,\"args\":object,\"dependsOn\":string[],\"purpose\":string}]}",
      "Use clarification when a required write parameter is missing or the request is ambiguous.",
      "Use unsupported when no supplied business action can fulfill the request.",
      "Represent dependencies explicitly using the id of prior steps in dependsOn.",
      "For follow-up turns: when updating tasks, use context.lastTaskIds only (task IDs with prefix M06-). When updating other records, use the matching IDs from context.selectedIds. Never apply an action to an ID belonging to a different module; do not create a new record.",
      "For indirect lead follow-up requests, prioritize M03.A03 (Search leads), M21.A03 (Search appointments), and M06.A01 (Create task) when those actions are present in the supplied catalog.",
      "Be concise. Return raw JSON matching the required schema immediately without verbose reasoning."
    ].join(" ");
    const isTaskQuery = /\btasks?\b/i.test(request.message);
    const cleanContext: Record<string, unknown> = {};
    if (Array.isArray(request.context?.lastTaskIds) && request.context.lastTaskIds.length) {
      cleanContext.lastTaskIds = request.context.lastTaskIds;
    }
    if (Array.isArray(request.context?.selectedIds) && request.context.selectedIds.length) {
      cleanContext.selectedIds = isTaskQuery && cleanContext.lastTaskIds
        ? request.context.selectedIds.filter((id) => typeof id === "string" && id.startsWith("M06"))
        : request.context.selectedIds;
    }
    const payload = {
      message: request.message,
      ...(Object.keys(cleanContext).length ? { context: cleanContext } : {}),
      candidates: compactCatalog
    };
    const hasFollowUpContext = Object.keys(cleanContext).length > 0;
    const requiresExpandedPlan = /\b(and|then|after|before|also|each|every|all|bulk|follow[- ]?up|if|unless|without|skip)\b/i.test(request.message)
      || request.message.length > 180
      || hasFollowUpContext;
    const response = await this.post({
      model: this.model,
      temperature: 0,
      max_tokens: requiresExpandedPlan ? 900 : 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) }
      ]
    }, request.sessionId);
    if (!response.ok) throw new Error("LLM provider returned HTTP " + response.status);
    const result = response.payload as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM provider returned no plan.");
    let plan: unknown;
    try {
      plan = JSON.parse(content);
    } catch {
      throw new Error("LLM provider returned invalid plan JSON.");
    }
    const inputTokens = result.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(payload).length / 4);
    const outputTokens = result.usage?.completion_tokens ?? Math.ceil(content.length / 4);
    return { plan, usage: { modelCalls: 1, inputTokens, outputTokens, estimatedCostUsd: this.estimatedCost(inputTokens, outputTokens) } };
  }
}

import { existsSync } from "node:fs";

export function providerFromEnvironment(): LLMProvider | undefined {
  if (typeof process.loadEnvFile === "function" && existsSync(".env") && !process.env.ASK_AI_LLM_API_KEY && !process.env.OPENAI_API_KEY) {
    try { process.loadEnvFile(".env"); } catch {}
  }
  const apiKey = process.env.ASK_AI_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  return apiKey ? new OpenAICompatibleProvider(apiKey) : undefined;
}
