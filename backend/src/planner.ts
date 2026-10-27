import type { ActionDefinition, JsonObject, PlanStep } from "./types.js";
import type { PlanDocument } from "./plan.js";
import type { LLMProvider, ProviderUsage } from "./provider.js";
import { AgentPlanGraph } from "./agent_graph.js";

export interface PlannerRequest {
  message: string;
  candidates: ActionDefinition[];
  context: JsonObject;
  sessionId?: string;
}

export interface PlannerResult {
  plan: PlanStep[];
  document: PlanDocument;
  usage: ProviderUsage;
}

/**
 * Provider-backed semantic planning. The provider proposes a plan; this class
 * rejects malformed plans, unknown actions, and actions outside retrieval.
 */
export class StructuredPlanner {
  private readonly graph: AgentPlanGraph;

  constructor(provider: LLMProvider, registry: ActionDefinition[]) {
    this.graph = new AgentPlanGraph(provider, registry);
  }

  async generate(request: PlannerRequest): Promise<PlannerResult> {
    return this.graph.invoke(request);
  }
}
